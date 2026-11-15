// client-runtime/preview/serverBrowserStream.ts and state/previewStream.ts: a server-hosted browser tab (runtime "server",
// the server's own Chromium that answers agents' preview_* tools) streams JPEG frames over `<origin>/api/preview-stream/ws`
// with the same media ticket as the device hub. NSH has no WebSocket outside a WebView page, so the client runs in the
// page (serverBrowserPage.ts); this file builds that page and holds the pure copy and decoding.
import { INSTALL_SERVER_BROWSER_SOURCE } from "./serverBrowserPage.generated";
import { installServerBrowser } from "./serverBrowserPage";

export { installServerBrowser };

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamControl {
  canOperate: boolean;
  controller: "agent" | "you" | "another-viewer" | "unclaimed";
  generation: number;
  dialog: null | { type: string; message: string; defaultValue: string };
}

export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Agent has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

export interface PreviewStreamHostSetup { need: "sandbox" | "libraries"; command: string }

export function decodeHostSetup(reason: string): PreviewStreamHostSetup {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if ((value.need === "sandbox" || value.need === "libraries") && typeof value.command === "string") return { need: value.need, command: value.command };
  } catch { /* not JSON */ }
  return { need: "sandbox", command: "sudo npx t3 browser setup" };
}

export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";

/** The stream socket's base (`${access.wsBase}/ws` plus the access query); the page appends threadId, tabId and the cap. */
/** previewStreamDownloadUrl (client-runtime/preview/serverBrowserStream.ts:137-148): a file the server tab downloaded. */
export function previewStreamDownloadUrl(endpoint: string, target: { threadId: string; tabId: string }, id: string, query: Record<string, string>): string | null {
  if (!URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  url.pathname = `${PREVIEW_STREAM_BASE_PATH}/download`; url.hash = "";
  url.search = new URLSearchParams({ threadId: target.threadId, tabId: target.tabId, id, ...query }).toString();
  return url.toString();
}

const isLocalLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
};

/** previewPdfAssetUrl (packages/shared/src/preview.ts:9-34): a server tab showing a signed /api/assets/*.pdf is drawn as
 * the document itself; a loopback asset address is fetched through this client's connection to the environment. */
export function previewPdfAssetUrl(rawUrl: string, httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null || !URL.canParse(rawUrl) || !URL.canParse(httpBaseUrl)) return null;
  const url = new URL(rawUrl);
  const baseUrl = new URL(httpBaseUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.pathname.startsWith("/api/assets/") || !/\.pdf$/i.test(url.pathname)) return null;
  if (url.origin !== baseUrl.origin && !isLocalLoopbackHost(url.hostname) && url.hostname !== "0.0.0.0") return url.href;
  return new URL(`${url.pathname}${url.search}${url.hash}`, baseUrl).href;
}

export function previewStreamSocketUrl(endpoint: string, query: Record<string, string>): string | null {
  if (!URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${PREVIEW_STREAM_BASE_PATH}/ws`; url.hash = "";
  url.search = new URLSearchParams(query).toString();
  return url.toString();
}

export const SERVER_BROWSER_SCRIPT = INSTALL_SERVER_BROWSER_SOURCE;

/** A theme colour put in the page's CSS: only #hex, rgb()/rgba()/hsl()/oklch() forms pass. */
const safeColor = (value: string): string => (/^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/a-z-]*\))$/.test(value.trim()) ? value.trim() : "#3b82f6");

/** The page: a black, contain-fitted canvas and the stream client. */
export function serverBrowserPage(cfg: { url: string; threadId: string; tabId: string; followSize?: boolean }, colors: { primary: string; background: string } = { primary: "#3b82f6", background: "#ffffff" }): string {
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const env = "{window:window,document:document,WebSocket:WebSocket,setTimeout:setTimeout.bind(window),clearTimeout:clearTimeout.bind(window),createImageBitmap:createImageBitmap.bind(window),Blob:Blob,ResizeObserver:window.ResizeObserver}";
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}canvas{display:block;width:100%;height:100%;object-fit:contain;touch-action:none;outline:none}#cur{display:none;pointer-events:none;position:absolute;left:0;top:0;z-index:40;transition:opacity 150ms ease-out,transform 150ms ease-out}#cur svg{position:relative;width:20px;height:20px;transform:translate(-2px,-2px);filter:drop-shadow(0 1px 1px rgba(0,0,0,.05))}#ping{display:none;position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:9999px;background:${safeColor(colors.primary)};opacity:.25;animation:ping 2s infinite}@keyframes ping{0%{opacity:.9;scale:.75;animation-timing-function:steps(8)}40%,100%{opacity:0;scale:2}}@media (prefers-reduced-motion:reduce){#cur{transition:none}#ping{animation:none}}</style><canvas id="c" tabindex="0"></canvas><textarea id="inp" aria-label="Browser page" aria-description="Press Shift+Escape to leave the browser page." autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" style="position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;resize:none;overflow:hidden">\u200b</textarea><div id="cur" aria-hidden="true"><span id="ping"></span><svg viewBox="0 0 24 24" fill="${safeColor(colors.background)}" stroke="${safeColor(colors.primary)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg></div><script>(${SERVER_BROWSER_SCRIPT})(${json},${env});</script>`;
}
