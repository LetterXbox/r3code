// usePreviewSession.ts + useDesktopHostedPreviewSessions + agentOpenedPreviews.ts followThread, for the port: lists the
// open thread's preview sessions (`preview.list`), follows `subscribePreviewEvents` for every thread (an event for another
// thread lists that thread too), keeps server tabs as panel tabs, and floats a tab an agent revealed
// (`browserAutoShowFloatingPreview`), or brings its panel tab to the front when the reveal is forced.
import { effect, untracked } from "nsh";
import { backendStatus, requestBackend, settingValue, subscribeBackend } from "../../store";
import { openMiniPlayer } from "./miniPlayerState";
import { retryingStream } from "../../environments/environmentSession";
import { currentWorkspace, panelKeyFor, panelStateFor, updatePanel } from "./panelState";
import {
  applyEvent, EMPTY_THREAD_PREVIEW, freshlyRevealed, panelServerTabs, reconcileList, reconcileServerSurfaces, serverPreviews, serverSurfaceId, settleServerTabCloses,
  type ThreadServerPreview,
} from "./serverPreviewSessions";

type Request = (method: string, payload: unknown) => Promise<unknown>;
type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;

/** One thread's new state: reveals run first (a revealed tab floats before it gains a panel tab), then the panel tabs. */
export function applyThreadPreview(threadId: string, next: ThreadServerPreview, options: { autoShowFloatingPreview: boolean }) {
  const previous = serverPreviews()[threadId] ?? EMPTY_THREAD_PREVIEW;
  serverPreviews.set({ ...serverPreviews(), [threadId]: next });
  if (!next.listLoaded) return;
  const key = panelKeyFor(threadId);
  const revealed = freshlyRevealed(previous, next);
  const before = panelStateFor(key);
  for (const session of revealed) {
    const force = session.revealRequest?.force === true;
    if (!options.autoShowFloatingPreview && !force) continue;
    const exists = before.surfaces.some((surface) => surface.id === serverSurfaceId(session.tabId));
    if (exists && force) updatePanel(key, (state) => ({ ...state, open: true, activeId: serverSurfaceId(session.tabId) }));
    else if (!exists) openMiniPlayer(key, serverSurfaceId(session.tabId));
  }
  settleServerTabCloses(threadId, next);
  updatePanel(key, (state) => reconcileServerSurfaces(state, panelServerTabs(next)));
  flushPreviewPopups(threadId);
}

// showPreviewPopup.ts (whenPreviewTabKnown + openBrowser): a popup the page opened becomes the panel's front tab once
// its session is known; until then it waits here.
const pendingPopups = new Map<string, Set<string>>();
function flushPreviewPopups(threadId: string) {
  const waiting = pendingPopups.get(threadId);
  if (!waiting) return;
  const key = panelKeyFor(threadId);
  for (const tabId of [...waiting]) {
    if (!panelStateFor(key).surfaces.some((surface) => surface.id === serverSurfaceId(tabId))) continue;
    waiting.delete(tabId);
    updatePanel(key, (state) => ({ ...state, open: true, activeId: serverSurfaceId(tabId) }));
  }
  if (waiting.size === 0) pendingPopups.delete(threadId);
}
export function showPreviewPopup(threadId: string, tabId: string) {
  const waiting = pendingPopups.get(threadId) ?? new Set<string>();
  waiting.add(tabId);
  pendingPopups.set(threadId, waiting);
  flushPreviewPopups(threadId);
}

export function watchServerPreviews(deps: { request?: Request; subscribe?: Subscribe; connected?: () => boolean; threadId?: () => string | null } = {}) {
  const request = deps.request ?? requestBackend;
  const subscribe = deps.subscribe ?? subscribeBackend;
  const connected = deps.connected ?? (() => backendStatus() === "connected");
  const openThreadId = deps.threadId ?? (() => currentWorkspace()?.threadId ?? null);
  const options = () => ({ autoShowFloatingPreview: settingValue("browserAutoShowFloatingPreview") !== false });
  const listing = new Set<string>();
  const list = (threadId: string) => {
    if (listing.has(threadId)) return;
    listing.add(threadId);
    void request("preview.list", { threadId })
      .then((result) => applyThreadPreview(threadId, reconcileList(serverPreviews()[threadId] ?? EMPTY_THREAD_PREVIEW, result), options()))
      .catch(() => {})
      .finally(() => listing.delete(threadId));
  };
  effect(() => {
    if (!connected()) return;
    // rpc/client.ts: the preview event stream resubscribes when it fails or ends while connected.
    const stop = retryingStream(subscribe as Parameters<typeof retryingStream>[0], "subscribePreviewEvents", {}, (event) => {
      const threadId = (event as { threadId?: unknown } | null)?.threadId;
      if (typeof threadId !== "string") return;
      untracked(() => {
        const current = serverPreviews()[threadId] ?? EMPTY_THREAD_PREVIEW;
        const next = applyEvent(current, event);
        if (next === "relist" || !current.listLoaded) { if (next !== "relist") applyThreadPreview(threadId, next, options()); list(threadId); return; }
        applyThreadPreview(threadId, next, options());
      });
    });
    return () => stop();
  });
  // client-runtime preview.ts: `preview.list` is a query with staleTimeMs 5_000, read when a thread is opened (events keep
  // it current after that). The open-thread effect re-runs on every workspace update: only opening a thread (again, after
  // 5 s) or a reconnect lists it.
  const listedAt = new Map<string, number>();
  let shownThread: string | null = null;
  effect(() => {
    const threadId = openThreadId();
    if (!connected()) { listedAt.clear(); shownThread = null; return; }
    if (threadId === shownThread) return;
    shownThread = threadId;
    if (!threadId) return;
    const now = Date.now();
    if (now - (listedAt.get(threadId) ?? -Infinity) < 5000) return;
    listedAt.set(threadId, now);
    untracked(() => list(threadId));
  });
}
