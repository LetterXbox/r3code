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

/** The page's reported icon: `{ t3: "favicon", page, href }` with an http(s) or data:image icon. */
export function parseFaviconMessage(data: string): { page: string; href: string } | null {
  try {
    const value = JSON.parse(data) as { t3?: unknown; page?: unknown; href?: unknown };
    if (value?.t3 !== "favicon" || typeof value.page !== "string" || typeof value.href !== "string") return null;
    if (!/^(https?:|data:image\/)/i.test(value.href) || value.href.length > 100_000) return null;
    return { page: value.page, href: value.href };
  } catch {
    return null;
  }
}
