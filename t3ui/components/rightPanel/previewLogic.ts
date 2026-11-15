// The preview browser's address and chrome rules (PreviewChromeRow.tsx, previewEmptyStateLogic.ts).
// Pure, so they are tested without an engine.

/** What the address bar's text opens: a URL as typed when it has a scheme, localhost and IPs over http, a bare host over https. Else null. */
export function normalizePreviewUrl(input: string): string | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return URL.canParse(text) ? text : null;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  const candidate = `https://${text}`;
  return /\./.test(text) && URL.canParse(candidate) ? candidate : null;
}

export interface PreviewChrome { address: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }

/** The row's state: no page yet means nothing to go back to or refresh. */
export function previewChrome(input: { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; hasPage: boolean }): PreviewChrome {
  return input.hasPage
    ? { address: input.url, loading: input.loading, canGoBack: input.canGoBack, canGoForward: input.canGoForward }
    : { address: "", loading: false, canGoBack: false, canGoForward: false };
}

// --- the empty state's cards (PreviewEmptyState.tsx, useDiscoveredLocalServers.ts, browserHistoryStore) ---

export interface BrowserHistoryEntry { url: string; title?: string; lastVisitedAt: number }

/** The "Recently used" rows: parseable URLs, newest first, at most 8 (PreviewEmptyState). */
export function recentEntries(entries: readonly BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  return [...entries].filter((entry) => URL.canParse(entry.url)).sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).slice(0, 8);
}

/** The row's second line: host and path, without a bare "/" (PreviewRecentUrlCard). */
export function recentLabel(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
}

// browserHistoryStore.ts:54-122: caps and the URL rules of the recents.
export const BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT = 50;
export const BROWSER_HISTORY_MAX_PROJECTS = 20;
const BROWSER_HISTORY_MAX_URL_LENGTH = 2048;
const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;

const historyHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
const isLoopbackHistoryHost = (host: string) => { const h = historyHost(host); return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h); };

/** normalizeHistoryUrl: http(s) only, credentials stripped, at most 2048 characters; else null. */
export function normalizeHistoryUrl(raw: string): string | null {
  const normalized = normalizePreviewUrl(raw);
  if (!normalized || !/^https?:\/\//i.test(normalized) || !URL.canParse(normalized)) return null;
  const parsed = new URL(normalized);
  parsed.username = ""; parsed.password = "";
  return parsed.href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : parsed.href;
}

/** visitLookupKey: the same server under localhost, 127.0.0.1, 0.0.0.0 or the environment's host is one entry. */
function visitLookupKey(url: string, environmentHostname?: string | null): string {
  const parsed = new URL(url);
  if (isLoopbackHistoryHost(parsed.hostname) || (environmentHostname && historyHost(parsed.hostname) === historyHost(environmentHostname))) parsed.hostname = "local";
  return parsed.href;
}

/** A visit recorded (upsertHistoryEntry): the page moves to the front, one entry per server address; a loopback address
 * already stored is kept over the environment's host name. A title, when the page reported one, is remembered. */
export function recordVisit(entries: readonly BrowserHistoryEntry[], rawUrl: string, now: number, title?: string, environmentHostname?: string | null): BrowserHistoryEntry[] {
  const url = normalizeHistoryUrl(rawUrl);
  if (!url) return [...entries];
  const key = visitLookupKey(url, environmentHostname);
  const existing = entries.find((entry) => URL.canParse(entry.url) && visitLookupKey(entry.url, environmentHostname) === key);
  const rest = entries.filter((entry) => entry !== existing);
  const stable = (value: string) => isLoopbackHistoryHost(new URL(value).hostname);
  const storedUrl = existing && (stable(existing.url) || !stable(url)) ? existing.url : url;
  const cleanTitle = title?.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
  const keptTitle = cleanTitle || existing?.title;
  const next: BrowserHistoryEntry = { url: storedUrl, lastVisitedAt: now, ...(keptTitle ? { title: keptTitle } : {}) };
  return [next, ...rest].slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
}

/** evictExcessProjects: the 20 projects visited most recently keep their recents. */
export function evictExcessProjects(byProject: Readonly<Record<string, BrowserHistoryEntry[]>>): Record<string, BrowserHistoryEntry[]> {
  const keys = Object.keys(byProject);
  if (keys.length <= BROWSER_HISTORY_MAX_PROJECTS) return { ...byProject };
  const kept = keys.sort((a, b) => (byProject[b]?.[0]?.lastVisitedAt ?? 0) - (byProject[a]?.[0]?.lastVisitedAt ?? 0)).slice(0, BROWSER_HISTORY_MAX_PROJECTS);
  return Object.fromEntries(kept.map((key) => [key, byProject[key] ?? []]));
}

export interface PreviewableServer { host: string; port: number; url: string; processName: string | null; source: "scanner" | "configured"; requestedUrl: string }

/** The `subscribeDiscoveredLocalServers` payload, read defensively (DiscoveredLocalServerList). */
export function readDiscoveredServers(value: unknown): { servers: { host: string; port: number; url: string; processName: string | null }[]; configuredUrlProbing: boolean } {
  const list = typeof value === "object" && value !== null ? (value as { servers?: unknown; configuredUrlProbing?: unknown }) : {};
  const servers: { host: string; port: number; url: string; processName: string | null }[] = [];
  if (Array.isArray(list.servers)) {
    for (const item of list.servers) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.host !== "string" || typeof row.port !== "number" || typeof row.url !== "string") continue;
      servers.push({ host: row.host, port: row.port, url: row.url, processName: typeof row.processName === "string" ? row.processName : null });
    }
  }
  return { servers, configuredUrlProbing: list.configuredUrlProbing === true };
}

/** getConfiguredPreviewUrls (previewEmptyStateLogic.ts): the preview URLs the project's scripts set. */
export function configuredPreviewUrls(scripts: readonly { previewUrl?: string }[] | undefined): string[] {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}

const PREVIEW_URL_MAX_LENGTH = 2048;
const CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS = 32;
const isLoopbackUrlHost = (host: string) => ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host);

/** boundConfiguredLocalServerUrls (portDiscoveryState.ts): http(s) loopback URLs, untrimmed or over 2048 characters
 * dropped, one per address without its hash, at most 32, before they go to the server's scan. */
export function boundConfiguredLocalServerUrls(urls: readonly string[] | undefined): string[] {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (raw.length === 0 || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim().length !== raw.length || !URL.canParse(raw)) continue;
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackUrlHost(url.hostname) || url.href.length > PREVIEW_URL_MAX_LENGTH) continue;
    const resource = new URL(url.href);
    resource.hash = "";
    if (seen.has(resource.href)) continue;
    seen.add(resource.href);
    bounded.push(url.href);
    if (bounded.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
  }
  return bounded;
}

/** Live servers, the ones a project script configures first, then by port (mergeServers). When the server does not probe
 * the configured URLs (configuredUrlProbing false), a configured server opens at its configured URL. */
export function mergeServers(scanner: readonly { host: string; port: number; url: string; processName: string | null }[], configuredUrls: readonly string[], configuredUrlProbing = true): PreviewableServer[] {
  const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());
  const key = (host: string, port: number) => `${loopback(host) ? "loopback" : host.toLowerCase()}:${port}`;
  const configured = new Map<string, string>();
  for (const url of configuredUrls) {
    if (!URL.canParse(url)) continue;
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || !loopback(parsed.hostname)) continue;
    const k = key(parsed.hostname, parsed.port ? Number(parsed.port) : parsed.protocol === "http:" ? 80 : 443);
    if (!configured.has(k)) configured.set(k, url);
  }
  return scanner
    .map((server): PreviewableServer => {
      const url = configured.get(key(server.host, server.port));
      return { ...server, requestedUrl: url !== undefined && !configuredUrlProbing ? url : server.url, source: url !== undefined ? "configured" : "scanner" };
    })
    .sort((a, b) => (a.source === b.source ? a.port - b.port : a.source === "configured" ? -1 : 1));
}

/** The icon's address: the site's own favicon (the WebView API reports no page icon). */
export function faviconUrl(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/favicon.ico` : null;
}

// --- the unreachable page (PreviewUnreachable.tsx, errorCodeMessages.ts, previewConstants.ts) ---

const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "DNS address could not be found",
  ERR_NAME_RESOLUTION_FAILED: "DNS address could not be found",
  ERR_CONNECTION_REFUSED: "Connection refused",
  ERR_CONNECTION_RESET: "Connection was reset",
  ERR_CONNECTION_CLOSED: "Connection was closed",
  ERR_CONNECTION_TIMED_OUT: "Connection timed out",
  ERR_INTERNET_DISCONNECTED: "No internet connection",
  ERR_TIMED_OUT: "Connection timed out",
  ERR_CERT_AUTHORITY_INVALID: "Certificate authority is not trusted",
  ERR_CERT_COMMON_NAME_INVALID: "Certificate hostname mismatch",
  ERR_CERT_DATE_INVALID: "Certificate is expired or not yet valid",
  ERR_TOO_MANY_REDIRECTS: "Too many redirects",
});

/** describePreviewError: a friendly line for a Chromium error code, else the raw description, else "Network error". */
export function describePreviewError(description: string): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return friendly;
  return description.length > 0 ? description : "Network error";
}

/** The host a page failed at (safeHost), falling back to the URL as given. */
export function previewHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}

/** The small caps code line of the unreachable page. */
export function previewErrorLabel(description: string, code?: number | string): string {
  // PreviewUnreachable.tsx:63: ERR_<code> when the description is empty, ERR_FAILED without a code.
  return description.length > 0 ? description : `ERR_${Math.abs(Number(code ?? 0)) || "FAILED"}`;
}

/** Whether a WebView download is the tab's navigation itself (its address, or the address it was loading), compared
 * without the hash; an in-page download of another URL is not. */
export function isNavigationDownload(downloadUrl: string, navigated: readonly string[]): boolean {
  const key = (value: string) => { if (!URL.canParse(value)) return null; const parsed = new URL(value); parsed.hash = ""; return parsed.href; };
  const target = key(downloadUrl);
  return target !== null && navigated.some((candidate) => key(candidate) === target);
}
