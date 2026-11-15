// The desktop browser bridge (workspace/council/server-integration/desktop-browser-bridge.md, host patch 0014,
// tools/desktop_browser_bridge.py): the server's browser drives this app's native WebView tabs over CDP, as the
// reference Electron host does (DesktopBrowserHost.ts, CdpRelay.ts). The app's part, as previewRuntime.ts
// rendersServerTabNatively: primary-environment tabs are server-runtime sessions drawn natively; a WebView carrying
// `bridgeMarker` in its injected script is the server's page for that tab (the host reports it `attached`). A host
// without the patch is never asked to (bridgeAvailable is false), and the launcher makes no bridge pipes for it.

import { host, signal } from "nsh";

// Only a host with patch 0014 answers `host.call("desktopBrowser.supported")` with true (and only with the launcher's
// relay socket set). The owner's hosts without it reject, and everything stays exactly as before: native tabs are
// desktop sessions, server tabs stream.
const supportedByHost = signal(false);

/** The host binds marked WebViews to the server's browser (patch 0014, relay up). */
export function bridgeAvailable(): boolean {
  return supportedByHost();
}

function askHost(): Promise<unknown> {
  if (!host.available()) return Promise.resolve(false);
  return host.call("desktopBrowser.supported", null);
}

/** Asks the host once (only `true` counts; a rejection leaves it off). `ask` is for tests. */
export function detectBridge(ask: () => Promise<unknown> = askHost): Promise<void> {
  let asked: Promise<unknown>;
  try { asked = ask(); } catch { asked = Promise.resolve(false); }
  return asked.then((value) => { supportedByHost.set(value === true); }, () => { supportedByHost.set(false); });
}
void detectBridge();

/** What the host reads from a WebView's injectedJavaScriptBeforeContentLoaded to bind it to a server tab. */
export function bridgeMarker(threadId: string, tabId: string): string {
  return `/*t3-desktop-browser ${JSON.stringify({ threadId, tabId }).replaceAll("*/", "*\\/")}*/`;
}

/** rendersServerTabNatively (previewRuntime.ts:44-56): a server tab of the primary environment that is not headless. */
export function rendersServerTabNatively(input: { available: boolean; primary: boolean; snapshot: { runtime?: string; headless?: boolean } | null | undefined }): boolean {
  return input.available && input.primary && input.snapshot?.runtime === "server" && input.snapshot.headless !== true;
}
