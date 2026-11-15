// previewRuntime.ts (apps/web/src/browser): where a browser tab runs. "desktop" is this computer's own WebView; "server"
// is the environment's browser (its Chromium, streamed). This app is the desktop shell, so the WebView preview is always
// supported (isPreviewSupportedInRuntime); the environment is the primary one when it is the app's own server, which
// this app reaches on a loopback address.
import { isLocalLoopbackHost } from "./previewOpeners";

export type PreviewRuntime = "desktop" | "server";

/** Whether the environment at `endpoint` is the primary (this computer's own) environment. */
export function isPrimaryEnvironmentEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  return isLocalLoopbackHost(new URL(endpoint).hostname);
}

/** previewRuntimeFor (previewRuntime.ts:13-23): undefined (the default, desktop) unless the environment has a server browser
 * and is the primary one. */
export function previewRuntimeFor(input: { serverBrowser: boolean; primary: boolean }): PreviewRuntime | undefined {
  if (!input.serverBrowser) return undefined;
  if (!input.primary) return undefined;
  return "server";
}

/** alternatePreviewRuntime (previewRuntime.ts:25-33): the runtime a tab can move to, null when it cannot move. */
export function alternatePreviewRuntime(input: { primary: boolean; serverBrowser: boolean; runtime: PreviewRuntime | null | undefined }): PreviewRuntime | null {
  if (!input.runtime || !input.serverBrowser) return null;
  if (input.primary) return null;
  return input.runtime === "server" ? "desktop" : "server";
}

/** isPreviewAvailableFor (previewRuntime.ts:35-37): the desktop shell always has its own preview. */
export const isPreviewAvailableFor = (): boolean => true;

/** PreviewView.tsx moveLabel. */
export const moveTabLabel = (target: PreviewRuntime, environmentLabel: string): string =>
  target === "server" ? `Open in ${environmentLabel}'s browser` : "Open on this computer";
