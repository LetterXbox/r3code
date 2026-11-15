// The reference Electron host's desktop tabs (openFileInPreview.ts openUrlInPreview, usePreviewBridge.ts buildReportInput,
// browserViewportActions.ts resizeBrowserViewport, BrowserProfileReporter.ts), for the port's native WebView tabs: a tab
// is registered with the server as a desktop-runtime preview session (`preview.open`, runtime omitted), so the agent's
// preview tools and other clients list it; its navigation is reported (`preview.reportStatus`, deduped on url and kind),
// its device-toolbar viewport is committed (`preview.resize`), and closing it ends the session (`preview.close`).
// The server cannot drive a desktop tab (its browser refuses: "This tab belongs to the desktop runtime"); see
// workspace/council/server-integration/desktop-browser-bridge.md.
import { effect, signal, untracked } from "nsh";
import { backendUrl, requestBackend, settingValue } from "../../store";
import { bridgeAvailable } from "../browser/desktopBrowserBridge";
import { isPrimaryEnvironmentEndpoint } from "../browser/previewRuntime";
import { showToast } from "../toast/toastState";

type Request = (method: string, payload: unknown) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);

export type NavKind = "Loading" | "Success" | "LoadFailed";
export interface TabNavState { kind: NavKind | "Idle"; url: string; title: string; code?: number; description?: string; canGoBack: boolean; canGoForward: boolean }
export type PreviewViewport = { _tag: "fill" } | Record<string, unknown>;

/** preview.open for a native tab; resolves the server's tab id. */
export async function registerDesktopTab(input: { threadId: string; url: string; viewport?: PreviewViewport; profileId?: string; runtime?: "server" }, request: Request = requestBackend): Promise<string | null> {
  const snapshot = record(await request("preview.open", {
    threadId: input.threadId, url: input.url,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
  }));
  return typeof snapshot?.tabId === "string" ? snapshot.tabId : null;
}

/** buildReportInput: nothing for Idle or a repeat of the last url and kind (a failure is always reported). */
export function buildReportInput(threadId: string, tabId: string, state: TabNavState, last: { url: string | null; kind: string | null }) {
  if (state.kind === "Idle") return null;
  if (state.kind !== "LoadFailed" && state.kind === last.kind && state.url === last.url) return null;
  const navStatus = state.kind === "LoadFailed"
    ? { _tag: "LoadFailed" as const, url: state.url, title: state.title, code: state.code ?? 0, description: state.description ?? "" }
    : { _tag: state.kind, url: state.url, title: state.title };
  return { threadId, tabId, navStatus, canGoBack: state.canGoBack, canGoForward: state.canGoForward };
}

/** One registered tab's reporter: report() on every navigation state, resize() on a viewport commit, close() once. */
export function desktopTabReporter(threadId: string, tabId: string, request: Request = requestBackend) {
  const last: { url: string | null; kind: string | null } = { url: null, kind: null };
  let closed = false;
  return {
    report(state: TabNavState) {
      if (closed) return;
      const input = buildReportInput(threadId, tabId, state, last);
      if (!input) return;
      last.url = state.url;
      last.kind = state.kind;
      void request("preview.reportStatus", input).catch(() => {});
    },
    resize(viewport: PreviewViewport): Promise<unknown> {
      return closed ? Promise.resolve(null) : request("preview.resize", { threadId, tabId, viewport });
    },
    close() {
      if (closed) return;
      closed = true;
      void request("preview.close", { threadId, tabId }).catch(() => {});
    },
  };
}

/** BrowserProfileReporter's report input from the client settings. */
export function profileReport(read: (key: string) => unknown = settingValue) {
  const profiles = Array.isArray(read("browserProfiles")) ? (read("browserProfiles") as unknown[]) : [];
  const defaultProfileId = typeof read("browserDefaultProfileId") === "string" ? (read("browserDefaultProfileId") as string) : "default";
  const rate = read("browserRecordingFrameRate");
  return { profiles, defaultProfileId, recordingFrameRate: rate === 60 ? 60 : 30 };
}

/** takeDueProfileReports for the one environment: report again on a new connection or when the input changes. */
export function createProfileReporter(request: Request = requestBackend) {
  let reportedKey = "";
  return (connectionKey: string, canOperate: boolean, serverBrowser: boolean, input = profileReport()) => {
    if (!canOperate || !serverBrowser) { reportedKey = ""; return false; }
    const key = `${connectionKey}\n${JSON.stringify(input)}`;
    if (key === reportedKey) return false;
    reportedKey = key;
    void request("preview.reportProfiles", input).catch(() => { if (reportedKey === key) reportedKey = ""; });
    return true;
  };
}

// ---- The live registry: one desktop session per native preview surface ----
interface LiveTab { threadId: string; tabId: string | null; reporter: ReturnType<typeof desktopTabReporter> | null; pending: TabNavState | null; closed: boolean; bridged: boolean; request: Request }
const live = new Map<string, LiveTab>();

// Desktop browser bridge (desktopBrowserBridge.ts): with the relay up, a primary-environment native tab is a server-runtime
// session the server drives through this WebView (previewRuntimeFor), not a desktop one: no navigation reports or
// resizes (the server reports its own tab), and its server tab id goes into the WebView's marker. surface key -> tab id.
export const bridgedTabs = signal<Readonly<Record<string, string>>>({});
/** The server tab a native surface is bound to (the WebView's marker), null while it is a desktop tab. */
export const bridgedTabIdFor = (surfaceKey: string) => bridgedTabs()[surfaceKey] ?? null;
/** Server tab ids native surfaces draw: they get no panel tab of their own (serverPreviewSessions.panelServerTabs). */
export const bridgedServerTabIds = () => new Set(Object.values(bridgedTabs()));
const setBridged = (surfaceKey: string, tabId: string | null) => {
  const { [surfaceKey]: _old, ...rest } = untracked(bridgedTabs);
  bridgedTabs.set(tabId ? { ...rest, [surfaceKey]: tabId } : rest);
};
export const useBridge = (deps: { available: () => boolean; primary: () => boolean } = { available: () => bridgeAvailable(), primary: () => isPrimaryEnvironmentEndpoint(backendUrl()) }) => deps.available() && deps.primary();

/** Called with each navigation state of a native preview surface: the first one with an address registers the tab.
 * `profileId` (reopenClosedView.ts's Surface.profileId, or undefined for the default profile) is sent on through to
 * registerDesktopTab -- its preview.open payload -- so the server's getPreviewConfig-equivalent resolves the same
 * partition browser cookie import writes into (browserCookieImport.ts's resolveWritePartition) and that
 * nativePreviewAdjust.ts's clear-cookies/clear-cache/appearance calls target. */
export function reportNativeTab(surfaceId: string, threadId: string, state: TabNavState, viewport?: PreviewViewport, request: Request = requestBackend, bridge: () => boolean = useBridge, profileId?: string) {
  let tab = live.get(surfaceId);
  if (tab && tab.threadId !== threadId) { closeNativeTab(surfaceId, request); tab = undefined; }
  if (!tab) {
    if (state.kind === "Idle" || !state.url) return;
    const bridged = bridge();
    const created: LiveTab = { threadId, tabId: null, reporter: null, pending: state, closed: false, bridged, request };
    live.set(surfaceId, created);
    void registerDesktopTab({ threadId, url: state.url, ...(viewport ? { viewport } : {}), ...(profileId ? { profileId } : {}), ...(bridged ? { runtime: "server" as const } : {}) }, request).then((tabId) => {
      if (!tabId) { if (live.get(surfaceId) === created) live.delete(surfaceId); return; }
      created.tabId = tabId;
      if (bridged) {
        if (created.closed) { void request("preview.close", { threadId, tabId }).catch(() => {}); return; }
        setBridged(surfaceId, tabId);
        return;
      }
      created.reporter = desktopTabReporter(threadId, tabId, request);
      if (created.closed) { created.reporter.close(); return; }
      if (created.pending) created.reporter.report(created.pending);
    }).catch(() => { if (live.get(surfaceId) === created) live.delete(surfaceId); });
    return;
  }
  if (tab.reporter) tab.reporter.report(state);
  else tab.pending = state;
}

/** The device toolbar committed a viewport for the surface (preview.resize once it is registered). */
export function resizeNativeTab(surfaceId: string, viewport: PreviewViewport, notify: (input: { type: "error"; title: string; description: string }) => unknown = showToast) {
  // resizeBrowserViewport (browserViewportActions.ts:81-87): a failed commit raises an error toast.
  void live.get(surfaceId)?.reporter?.resize(viewport).catch((error: unknown) => {
    notify({ type: "error", title: "Unable to resize browser viewport", description: error instanceof Error ? error.message : "An error occurred." });
  });
}

/** The surface closed: its desktop session ends. */
export function closeNativeTab(surfaceId: string, _request: Request = requestBackend) {
  const tab = live.get(surfaceId);
  if (!tab) return;
  live.delete(surfaceId);
  tab.closed = true;
  tab.reporter?.close();
  if (tab.bridged && tab.tabId) {
    setBridged(surfaceId, null);
    void tab.request("preview.close", { threadId: tab.threadId, tabId: tab.tabId }).catch(() => {});
  }
}

export const nativeTabIdForTest = (surfaceId: string) => live.get(surfaceId)?.tabId ?? null;

/** startBrowserProfileReporting for the primary environment: reported on each connection, grant and settings change. */
export function installBrowserProfileReporting(deps: { connected: () => boolean; connectionKey: () => string; canOperate: () => boolean; serverBrowser: () => boolean }) {
  const report = createProfileReporter();
  effect(() => {
    if (!deps.connected()) return;
    const input = profileReport();
    const key = deps.connectionKey();
    const can = deps.canOperate();
    const browser = deps.serverBrowser();
    untracked(() => report(key, can, browser, input));
  });
}
