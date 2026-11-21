// The ways something else in the app opens a page in the preview browser: "Open file in preview browser" (openFileInPreview.ts),
// a link clicked in a terminal (openTerminalLinkInPreview.ts) and a discovered local server (openDiscoveredPort.ts,
// browserTargetResolver.ts). The reference opens a server-owned preview session; here a browser tab of the right panel
// holds the address and its own WebView, so each opener ends in `openBrowserAction(url)`. Each needs the environment's
// preview operate scope, as the reference's openers do (canOpenLinksInApp, canOperatePreview).
import { backendUrl, requestBackend } from "../../store";
import { assetUrlFor } from "../sidebar/projectIcon";
import { openBrowserAction, surfaceAvailability } from "../rightPanel/panelState";
import { recordBrowserVisit } from "../rightPanel/previewEmpty";
import { canOperatePreview, previewScopeState } from "../rightPanel/previewScope";
import { clipboardPathFor } from "../rightPanel/tabMenuLogic";
import { normalizePreviewUrl } from "../rightPanel/previewLogic";
import { errorToast } from "../toast/toastState";

type Request = (method: string, payload: unknown) => Promise<unknown>;

export const isBrowserPreviewFile = (path: string): boolean => /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export function isWebUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
}

/** canOpenLinksInApp (browserLinkTarget.ts): a thread with a panel, and the preview operate scope. */
export function canOpenLinksInApp(): boolean {
  return surfaceAvailability().rightPanel && canOperatePreview();
}

export class PreviewUnavailableError extends Error {}

/**
 * A page opens in a new browser tab and joins the "Recently used" list. Only a session that answered without the scope is refused:
 * the rows that offer this stay usable until the session is known, as the details card's do.
 */
export function openUrlInPreviewTab(url: string): void {
  if (previewScopeState() === "denied") throw new PreviewUnavailableError("Preview access is unavailable for this client.");
  recordBrowserVisit(url);
  openBrowserAction(url);
}

/** Whether the file has a "Open file in preview browser" action (FilePreviewPanel canOpenInBrowser). */
export function canOpenFileInPreview(relativePath: string): boolean {
  return canOperatePreview() && surfaceAvailability().rightPanel && isBrowserPreviewFile(relativePath);
}

/** assets.createUrl's resource for a file (openFileInPreview): a workspace file inside the project folder, else a media file. */
export function previewAssetResource(threadId: string, filePath: string, workspaceRoot: string | undefined): { _tag: "workspace-file" | "media-file"; threadId: string; path: string } {
  const root = (workspaceRoot ?? "").replace(/[\\/]+$/, "");
  const inside = root !== "" && filePath.replaceAll("\\", "/").toLowerCase().startsWith(`${root.replaceAll("\\", "/").toLowerCase()}/`);
  return { _tag: inside ? "workspace-file" : "media-file", threadId, path: filePath };
}

/** openFileInPreview: a signed asset URL for the file, opened in a browser tab. Throws with the reason it could not. */
export async function openFileInPreview(
  input: { threadId: string; filePath: string; workspaceRoot: string | undefined },
  deps: { request?: Request; endpoint?: string; open?: (url: string) => void } = {},
): Promise<string> {
  if (previewScopeState() === "denied") throw new PreviewUnavailableError("Preview access is unavailable for this client.");
  const request = deps.request ?? requestBackend;
  const response = await request("assets.createUrl", { resource: previewAssetResource(input.threadId, input.filePath, input.workspaceRoot) });
  const relativeUrl = typeof response === "object" && response !== null ? (response as { relativeUrl?: unknown }).relativeUrl : undefined;
  const url = assetUrlFor(deps.endpoint ?? backendUrl(), relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid asset URL.");
  (deps.open ?? openUrlInPreviewTab)(url);
  return url;
}

/** The file panel's "Open file in preview browser": a failure is a toast titled "Unable to open file in browser". */
export async function openFileInPreviewBrowser(input: { threadId: string; cwd: string; relativePath: string }): Promise<void> {
  try {
    await openFileInPreview({ threadId: input.threadId, filePath: clipboardPathFor(input.relativePath, input.cwd), workspaceRoot: input.cwd });
  } catch (cause) {
    errorToast("Unable to open file in browser", cause instanceof Error && cause.message ? cause.message : "An error occurred.");
  }
}

// preview.ts LOOPBACK_HOSTS / isLoopbackHost: the hosts a discovered server reports for "this machine".
const isLoopbackHost = (host: string) => ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host.toLowerCase());

// hostClassification.ts (packages/shared): normalizeHostname, isLocalLoopbackHost, isPrivateNetworkHost.
const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/u, "");

function parseIpv4(host: string): number[] | null {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function parseIpv4MappedIpv6(host: string): number[] | null {
  const normalized = normalizeHostname(host);
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  const dotted = parseIpv4(suffix);
  if (dotted) return dotted;
  const hextets = suffix.split(":");
  if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

const isPrivateIpv4 = (p: readonly number[]): boolean =>
  p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31)
  || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 198 && p[1]! >= 18 && p[1]! <= 19);

export function isLocalLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4(normalized)?.[0] === 127;
}

export function isPrivateNetworkHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "::" || isLocalLoopbackHost(normalized) || normalized.endsWith(".localhost") || normalized.endsWith(".local")
    || normalized === "home.arpa" || normalized.endsWith(".home.arpa") || (!normalized.includes(".") && !normalized.includes(":"))) return true;
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4(normalized) ?? parseIpv4MappedIpv6(normalized);
  if (parts) return isPrivateIpv4(parts);
  const first = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(first)) return false;
  const hextet = Number.parseInt(first, 16);
  return Number.isInteger(hextet) && ((hextet & 0xfe00) === 0xfc00 || (hextet & 0xffc0) === 0xfe80);
}

/**
 * resolveDiscoveredServerUrl (browserTargetResolver.ts:62-88): the address is normalized first. A loopback server stays as it
 * is when the connection reaches the environment's loopback (the app's own server, here one on a loopback address:
 * reachesEnvironmentLoopback); on another machine it is rewritten to that machine's host (resolveEnvironmentPortTarget),
 * keeping its port, path, search and hash, but only when that host is private-network reachable; otherwise (and on any
 * error) the address is opened as given.
 */
export function resolveDiscoveredServerUrl(environmentEndpoint: string, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    if (normalizedUrl === null) return rawUrl;
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    if (!URL.canParse(environmentEndpoint)) return rawUrl;
    const environment = new URL(environmentEndpoint);
    const environmentHost = normalizeHostname(environment.hostname);
    if (isLocalLoopbackHost(environmentHost)) return normalizedUrl;
    if (!isPrivateNetworkHost(environment.hostname)) return rawUrl;
    const resolved = new URL(parsed);
    resolved.hostname = environmentHost.includes(":") ? `[${environmentHost}]` : environmentHost;
    resolved.port = String(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
    return resolved.toString();
  } catch {
    return rawUrl;
  }
}

export interface PreviewTunnelConfig {
  readonly settings?: { readonly enablePreviewTunnel?: boolean };
  readonly managedPolicy?: { readonly limits?: { readonly previewTunnel?: boolean } } | null;
}

/** Whether the preview tunnel serves: the setting is on and no managed policy disables it. */
export function allowsPreviewTunnel(config: PreviewTunnelConfig | null | undefined): boolean {
  if (!config) return false;
  return config.settings?.enablePreviewTunnel !== false && config.managedPolicy?.limits?.previewTunnel !== false;
}

/** Builds the `/api/preview/tunnel` WebSocket URL with a media ticket query parameter when provided. */
export function previewTunnelUrl(environmentEndpoint: string, wsTicket?: string | null): string | null {
  if (!URL.canParse(environmentEndpoint)) return null;
  const url = new URL("/api/preview/tunnel", environmentEndpoint);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (wsTicket) url.searchParams.set("wsTicket", wsTicket);
  return url.toString();
}

/** Resolves a discovered server URL for opening in the system browser, detecting unreachable remote loopback addresses. */
export function resolveExternalServerTarget(environmentEndpoint: string, rawUrl: string): { url: string; remoteLoopbackUnavailable: boolean } {
  const url = resolveDiscoveredServerUrl(environmentEndpoint, rawUrl);
  try {
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname) && URL.canParse(environmentEndpoint)) {
      const env = new URL(environmentEndpoint);
      if (!isLocalLoopbackHost(env.hostname)) {
        return { url, remoteLoopbackUnavailable: true };
      }
    }
  } catch {}
  return { url, remoteLoopbackUnavailable: false };
}

/** openDiscoveredPort: a discovered local server opens in a new browser tab. */
export function openDiscoveredServer(url: string, endpoint: string = backendUrl()): void {
  openUrlInPreviewTab(resolveDiscoveredServerUrl(endpoint, url));
}
