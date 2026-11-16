// Native WebView preview tabs (surfaces.tsx's PreviewPage): clear cookies, clear cache and a colour-scheme override,
// parity with serverPreviewAdjust.ts's preview.adjust for server-hosted tabs. The reference (Manager.ts, BrowserSession.ts)
// does all three through Electron APIs with no NSH equivalent today:
//  - clearCookies / clearCache: session.clearStorageData for the tab's partition (ipc/methods/preview.ts's
//    clearCookies/clearCache, resolvePartitionScope). Already declared as webview.cookies.clear / webview.cache.clear
//    in third_party/nsh-host-patches/0022-gpui-webview-cookie-store.patch (UNVERIFIED, not built; see
//    browserCookieImport.ts's writeImportedCookies for the same gating pattern). This reuses those two call names and
//    resolveWritePartition's partition key, so clearing a profile's cookies hits exactly the partition browser cookie
//    import writes into.
//  - colour scheme: a CDP `Emulation.setEmulatedMedia` call on the tab's webContents.debugger (Manager.ts:2337-2374),
//    which has no NSH analogue at all (no debugger/CDP surface, no per-WKWebView media-emulation API). This adds a new
//    call, webview.appearance.set, documented as an UNVERIFIED sketch in
//    third_party/nsh-host-patches/0024-gpui-webview-appearance.patch. That patch scopes the override to the tab's
//    *partition* (its WKWebsiteDataStore), not the individual WKWebView instance -- NSH's WebView has no per-view
//    host-call addressing (grepped patch 0015's webview.capture: it addresses by on-screen point, not by a stable view
//    id), so two native tabs sharing a partition would share the override. That is a real divergence from the
//    reference's true per-tab CDP emulation and must stay documented, not silently narrowed away.
// On a host without 0022 or 0024, every function below shows an error toast naming the missing patch rather than
// quietly doing nothing (the same choice writeImportedCookies makes for sessionUnavailable).
import { host, signal } from "nsh";
import { desktopHostCapabilities } from "../../desktop/desktopHost";
import { resolveWritePartition } from "../browser/browserCookieImport";
import { showToast } from "../toast/toastState";
import type { PreviewColorScheme } from "./previewMore";

type Notify = (input: { type: "error"; title: string; description: string }) => unknown;
type HostCall = (name: string, data: unknown) => Promise<unknown>;

/** The same partition key browserCookieImport.ts's resolveWritePartition derives (resolvePartitionScope,
 * ipc/methods/preview.ts): the bare environment id for the default profile, else `[environmentId, profileId]`. */
export const resolveNativePartition = (environmentId: string, profileId: string | undefined): string => resolveWritePartition(environmentId, profileId);

async function callGated(name: string, data: unknown, patch: string, title: string, notify: Notify, call: HostCall): Promise<boolean> {
  if (!(await desktopHostCapabilities()).has(name)) {
    notify({ type: "error", title, description: `This build's NSH host has no ${name} call (needs third_party/nsh-host-patches/${patch}).` });
    return false;
  }
  try {
    await call(name, data);
    return true;
  } catch (cause) {
    notify({ type: "error", title, description: cause instanceof Error ? cause.message : "An error occurred." });
    return false;
  }
}

const defaultCall: HostCall = (name, data) => host.call(name, data, { timeout: 5000 });

/** Clears every cookie of the native tab's partition (preview.ts's clearCookies, omitting `name`: every cookie). */
export const clearNativeCookies = (environmentId: string, profileId: string | undefined, notify: Notify = showToast, call: HostCall = defaultCall): Promise<boolean> =>
  callGated("webview.cookies.clear", { partition: resolveNativePartition(environmentId, profileId) }, "0022-gpui-webview-cookie-store.patch", "Unable to clear cookies", notify, call);

/** Clears the native tab's partition's cache (preview.ts's clearCache). */
export const clearNativeCache = (environmentId: string, profileId: string | undefined, notify: Notify = showToast, call: HostCall = defaultCall): Promise<boolean> =>
  callGated("webview.cache.clear", { partition: resolveNativePartition(environmentId, profileId) }, "0022-gpui-webview-cookie-store.patch", "Unable to clear cache", notify, call);

/** Each native tab's colour-scheme override, keyed by the same surface key reportNativeTab uses; "system" before any. */
export const nativeTabScheme = signal<Readonly<Record<string, PreviewColorScheme>>>({});
export const nativeTabSchemeFor = (surfaceKey: string) => nativeTabScheme()[surfaceKey] ?? "system";

/** PreviewMoreMenu's Appearance submenu for a native tab: sets the override only once the host confirms it, so a
 * host without 0024 leaves the menu (and the page) exactly as they were, with an error toast explaining why. */
export async function setNativeColorScheme(surfaceKey: string, environmentId: string, profileId: string | undefined, scheme: PreviewColorScheme, notify: Notify = showToast, call: HostCall = defaultCall): Promise<boolean> {
  const ok = await callGated("webview.appearance.set", { partition: resolveNativePartition(environmentId, profileId), scheme }, "0024-gpui-webview-appearance.patch", "Unable to change appearance", notify, call);
  if (ok) nativeTabScheme.update((all) => ({ ...all, [surfaceKey]: scheme }));
  return ok;
}

/** Tests / a closed tab: drops its remembered override so a later tab at the same surface key starts at "system". */
export const forgetNativeColorScheme = (surfaceKey: string) => { const { [surfaceKey]: _old, ...rest } = nativeTabScheme(); nativeTabScheme.set(rest); };

// DevTools (Safari Web Inspector) for native tabs: previewMore.tsx's "Open DevTools" row had no host equivalent at
// all (DESKTOP_PARITY_AUDIT.md's "DevTools" item: neither WebViewHostProps nor WebViewRef exposed an inspector).
// third_party/nsh-host-patches/0025-gpui-webview-devtools.patch adds two calls: webview.devtools.setInspectable
// { enabled } (the public WKWebView.inspectable property, macOS 13.3+) and webview.devtools.open {} (the private,
// undocumented -[WKWebView _showInspector], best-effort -- see that patch's header for why it is documented as
// private API rather than hidden). Like webview.appearance.set, neither is scoped to one WKWebView instance:
// NSH's WebView has no per-view host-call addressing, so these affect every WKWebView shown right now.

/** Whether this host's build carries 0025, resolved once; previewMore.tsx's PreviewMoreMenu reads this to decide
 * whether to render the "Open DevTools" row at all, rather than rendering a row a host without 0025 can never act on. */
export const nativeDevToolsAvailable = signal(false);
void (async () => { nativeDevToolsAvailable.set((await desktopHostCapabilities()).has("webview.devtools.open")); })();

/** PreviewMoreMenu's "Open DevTools" row for a native tab: makes the tab's web views inspectable, then asks the
 * host to show the inspector (best-effort -- `webview.devtools.open` is a private selector, see the patch header);
 * a host without 0025 never reaches here, nativeDevToolsAvailable keeps the row off the menu. */
export async function openNativeDevTools(notify: Notify = showToast, call: HostCall = defaultCall): Promise<boolean> {
  await callGated("webview.devtools.setInspectable", { enabled: true }, "0025-gpui-webview-devtools.patch", "Unable to enable DevTools", () => {}, call);
  return callGated("webview.devtools.open", {}, "0025-gpui-webview-devtools.patch", "Unable to open DevTools", notify, call);
}
