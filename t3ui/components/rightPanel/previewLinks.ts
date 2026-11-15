// Links a page opens on its own (HostedBrowserWebview allowpopups, ElectronBrowserHost openLinkInPreview, showPreviewPopup):
// window.open and target=_blank links open as a new browser tab; a Cmd/Ctrl-click or middle click on a link opens it in a
// background tab, which leaves the tab in front where it was (openUrlInPreview background). NSH's WebView reports no
// new-window request, so a script that runs before the page's own reports them (`window.nsh.postMessage`).

import { INSTALL_OPEN_LINK_SOURCE } from "./previewLinksPage.generated";
import { installOpenLink } from "./previewLinksPage";

export interface PageOpenLink { url: string; background: boolean }

/** The page's report: `{ t3: "open-link", url, background }` with an http(s) URL; null for anything else a page posts. */
export function parseOpenLinkMessage(data: string): PageOpenLink | null {
  try {
    const value = JSON.parse(data) as { t3?: unknown; url?: unknown; background?: unknown };
    if (value?.t3 !== "open-link" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url) || !URL.canParse(value.url)) return null;
    return { url: value.url, background: value.background === true };
  } catch {
    return null;
  }
}

/** Runs before the page's scripts (`injectedJavaScriptBeforeContentLoaded`). */
export const OPEN_LINK_SCRIPT = `(${INSTALL_OPEN_LINK_SOURCE})({window:window,document:document,URL:URL});`;

export { installOpenLink };

// FaviconCapture.ts parity (reference apps/desktop/src/preview/FaviconCapture.ts): isSupportedFaviconUrl caps an
// http(s) candidate at MAX_FAVICON_HTTP_URL_LENGTH and a data: one at MAX_FAVICON_RESPONSE_BYTES (its decoded byte
// size, checked after fetching; this port has no fetch step for a page-reported icon, so the data: URL's own char
// length is used as a conservative proxy -- base64 inflates the true byte count by ~4/3, so this bound is stricter,
// never looser, than the reference's). normalizeFaviconBuffer always rejects `image/svg+xml` (an inline SVG can
// carry a <script>), which this mirrors for the one case it can check without fetching: a `data:` URL's own
// declared mime. An http(s) candidate's real content-type is unknown until it loads, so an .svg-looking http(s)
// URL still passes here -- a gap, not a silent narrowing; FaviconCapture.ts's pixel-dimension cap and 32x32
// rasterization (createImageBitmap/OffscreenCanvas in an isolated world, webContents.session.fetch) have no port at
// all: NSH's WebView exposes neither an isolated-world script execution nor a main-process fetch with per-request
// credentials, so there is nowhere to run that pipeline from.
const MAX_FAVICON_HTTP_URL_LENGTH = 2_048;
const MAX_FAVICON_DATA_URL_LENGTH = 100_000;

/** The page's reported icon: `{ t3: "favicon", page, href }` with an http(s) or data:image (never data:image/svg+xml) icon. */
export function parseFaviconMessage(data: string): { page: string; href: string } | null {
  try {
    const value = JSON.parse(data) as { t3?: unknown; page?: unknown; href?: unknown };
    if (value?.t3 !== "favicon" || typeof value.page !== "string" || typeof value.href !== "string") return null;
    const href = value.href;
    if (/^data:/i.test(href)) {
      if (href.length > MAX_FAVICON_DATA_URL_LENGTH || /^data:image\/svg\+xml/i.test(href)) return null;
      if (!/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(href)) return null;
      return { page: value.page, href };
    }
    if (!/^https?:/i.test(href) || href.length > MAX_FAVICON_HTTP_URL_LENGTH) return null;
    return { page: value.page, href };
  } catch {
    return null;
  }
}
