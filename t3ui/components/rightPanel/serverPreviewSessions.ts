// previewStateStore.ts (reconcilePreviewServerSessions, applyPreviewServerEvent), usePreviewSession.ts and
// agentOpenedPreviews.ts (followPreviewSessions, freshlyRevealedServerTabs, revealServerTabs): the thread's preview
// sessions as the server reports them (`preview.list` + `subscribePreviewEvents`). Server-runtime sessions are the tabs
// the server's own browser hosts (an agent's preview_open); they become panel tabs and, when revealed, float over chat.
// The reducers are pure, so they are unit tested; RightPanel.tsx applies their results.
import { signal } from "nsh";
import { bridgedServerTabIds } from "./desktopPreviewSessions";

export interface PreviewSessionSnapshot {
  threadId: string;
  tabId: string;
  navStatus: { _tag: "Idle" } | { _tag: "Loading" | "Success" | "LoadFailed"; url: string; title: string; code?: number; description?: string };
  canGoBack: boolean;
  canGoForward: boolean;
  runtime?: "desktop" | "server";
  headless?: boolean;
  reveal?: boolean;
  revealRequest?: { id: string; force: boolean };
  /** The browser profile the session runs in (reopenClosedView.ts view.snapshot.profileId). */
  profileId?: string;
  updatedAt: string;
}

export interface ThreadServerPreview {
  listLoaded: boolean;
  serverEpoch: string | null;
  serverRevision: number;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}

export const EMPTY_THREAD_PREVIEW: ThreadServerPreview = { listLoaded: false, serverEpoch: null, serverRevision: 0, sessions: {} };

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);

export function readSnapshot(value: unknown): PreviewSessionSnapshot | null {
  const v = record(value);
  if (!v || typeof v.threadId !== "string" || typeof v.tabId !== "string") return null;
  const nav = record(v.navStatus);
  const tag = nav?._tag;
  const navStatus = tag === "Loading" || tag === "Success" || tag === "LoadFailed"
    ? { _tag: tag, url: String(nav!.url ?? ""), title: String(nav!.title ?? ""), ...(typeof nav!.code === "number" ? { code: nav!.code } : {}), ...(typeof nav!.description === "string" ? { description: nav!.description } : {}) }
    : { _tag: "Idle" as const };
  const reveal = record(v.revealRequest);
  return {
    threadId: v.threadId, tabId: v.tabId, navStatus: navStatus as PreviewSessionSnapshot["navStatus"],
    canGoBack: v.canGoBack === true, canGoForward: v.canGoForward === true,
    ...(v.runtime === "server" || v.runtime === "desktop" ? { runtime: v.runtime } : {}),
    ...(typeof v.headless === "boolean" ? { headless: v.headless } : {}),
    ...(typeof v.reveal === "boolean" ? { reveal: v.reveal } : {}),
    ...(reveal && typeof reveal.id === "string" ? { revealRequest: { id: reveal.id, force: reveal.force === true } } : {}),
    ...(typeof v.profileId === "string" && v.profileId !== "" ? { profileId: v.profileId } : {}),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

/** reconcilePreviewServerSessions: the list is authoritative; a newer local snapshot of the same server wins. */
export function reconcileList(current: ThreadServerPreview, result: unknown): ThreadServerPreview {
  const r = record(result);
  if (!r || typeof r.serverEpoch !== "string" || !Array.isArray(r.sessions)) return current;
  const revision = typeof r.revision === "number" ? r.revision : 0;
  const sameServer = current.serverEpoch === r.serverEpoch;
  if (sameServer && revision < current.serverRevision) return current;
  const sessions: Record<string, PreviewSessionSnapshot> = {};
  for (const item of r.sessions) {
    const snapshot = readSnapshot(item);
    if (!snapshot) continue;
    const existing = sameServer ? current.sessions[snapshot.tabId] : undefined;
    sessions[snapshot.tabId] = existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot;
  }
  return { listLoaded: true, serverEpoch: r.serverEpoch, serverRevision: revision, sessions };
}

/** applyPreviewServerEvent. Returns `"relist"` when the event comes from another server process. */
export function applyEvent(current: ThreadServerPreview, event: unknown): ThreadServerPreview | "relist" {
  const e = record(event);
  if (!e || typeof e.tabId !== "string" || typeof e.serverEpoch !== "string") return current;
  if (current.serverEpoch !== null && e.serverEpoch !== current.serverEpoch) return "relist";
  const revision = typeof e.revision === "number" ? e.revision : 0;
  if (revision < current.serverRevision) return current;
  const base = { ...current, serverEpoch: e.serverEpoch, serverRevision: revision };
  if (e.type === "opened" || e.type === "navigated" || e.type === "resized") {
    const snapshot = readSnapshot(e.snapshot);
    return snapshot ? { ...base, sessions: { ...current.sessions, [snapshot.tabId]: snapshot } } : current;
  }
  if (e.type === "failed") {
    const existing = current.sessions[e.tabId];
    if (!existing) return base;
    const failed = { ...existing, navStatus: { _tag: "LoadFailed" as const, url: String(e.url ?? ""), title: String(e.title ?? ""), code: Number(e.code ?? 0), description: String(e.description ?? "") }, updatedAt: String(e.createdAt ?? existing.updatedAt) };
    return { ...base, sessions: { ...current.sessions, [e.tabId]: failed } };
  }
  if (e.type === "closed") {
    const { [e.tabId]: _closed, ...rest } = current.sessions;
    return { ...base, sessions: rest };
  }
  return current;
}

/** freshlyRevealedServerTabs: new server tabs, or a new reveal request; nothing before the first list (the baseline). */
export function freshlyRevealed(previous: ThreadServerPreview, next: ThreadServerPreview): PreviewSessionSnapshot[] {
  if (!previous.listLoaded || previous.sessions === next.sessions) return [];
  return Object.values(next.sessions).filter((session) => {
    if (session.runtime !== "server" || session.reveal !== true) return false;
    const before = previous.sessions[session.tabId];
    const requested = session.revealRequest;
    return requested ? before?.revealRequest?.id !== requested.id : before === undefined;
  });
}

// beginPreviewSessionClose / cancelPreviewSessionClose (previewStateStore.ts:422-460): a tab this client is closing stays
// out of the panel even when a list from before the close still has it; it is forgotten once the server drops it.
const closingServerTabs = new Set<string>();
const closingKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;
export function beginServerTabClose(threadId: string, tabId: string) { closingServerTabs.add(closingKey(threadId, tabId)); }
export function cancelServerTabClose(threadId: string, tabId: string) { closingServerTabs.delete(closingKey(threadId, tabId)); }
/** Forgets closes the server has carried out (the session is gone from `state`). */
export function settleServerTabCloses(threadId: string, state: ThreadServerPreview) {
  for (const key of [...closingServerTabs]) {
    const [thread, tab] = key.split("\u0000");
    if (thread === threadId && tab !== undefined && state.listLoaded && state.sessions[tab] === undefined) closingServerTabs.delete(key);
  }
}

/** reconcileBrowserSurfaces' input: the server tabs that get a panel tab (all but `reveal: false` server sessions, and
 * those this client is closing). */
export function panelServerTabs(state: ThreadServerPreview): PreviewSessionSnapshot[] {
  const bridged = bridgedServerTabIds();
  return Object.values(state.sessions).filter((session) => session.runtime === "server" && session.reveal !== false && !closingServerTabs.has(closingKey(session.threadId, session.tabId)) && !bridged.has(session.tabId));
}

export const sessionUrl = (session: PreviewSessionSnapshot) => (session.navStatus._tag === "Idle" ? "" : session.navStatus.url);
export const sessionTitle = (session: PreviewSessionSnapshot) => (session.navStatus._tag === "Idle" ? "" : session.navStatus.title);

/** Panel surface id of a server tab. */
export const serverSurfaceId = (tabId: string) => `server-preview:${tabId}`;

// The live store: thread id -> its sessions.
export const serverPreviews = signal<Readonly<Record<string, ThreadServerPreview>>>({});
export const serverPreviewFor = (threadId: string) => serverPreviews()[threadId] ?? EMPTY_THREAD_PREVIEW;

/**
 * reconcileBrowserSurfaces (rightPanelStore.ts) for server tabs: a panel tab per server session (not opened or
 * activated), its address kept current; tabs of ended sessions go. Local browser tabs are left alone.
 */
export function reconcileServerSurfaces<S extends { open: boolean; activeId: string | null; surfaces: { id: string; kind: string; serverTabId?: string; previewUrl?: string }[] }>(state: S, tabs: readonly PreviewSessionSnapshot[]): S {
  const byId = new Map(tabs.map((tab) => [serverSurfaceId(tab.tabId), tab]));
  let changed = false;
  const kept = state.surfaces.flatMap((surface) => {
    if (!surface.serverTabId) return [surface];
    const tab = byId.get(surface.id);
    if (!tab) { changed = true; return []; }
    const url = sessionUrl(tab);
    if ((surface.previewUrl ?? "") === url) return [surface];
    changed = true;
    return [{ ...surface, previewUrl: url }];
  });
  const known = new Set(kept.map((surface) => surface.id));
  const added = tabs.filter((tab) => !known.has(serverSurfaceId(tab.tabId))).map((tab) => ({ id: serverSurfaceId(tab.tabId), kind: "preview", serverTabId: tab.tabId, previewUrl: sessionUrl(tab) }));
  if (!changed && added.length === 0) return state;
  const surfaces = [...kept, ...added];
  const closedLast = surfaces.length === 0 && state.surfaces.some((surface) => surface.serverTabId);
  const activeId = surfaces.some((surface) => surface.id === state.activeId) ? state.activeId : (surfaces.find((surface) => surface.kind === "preview")?.id ?? surfaces[0]?.id ?? null);
  return { ...state, open: closedLast ? false : state.open, surfaces, activeId };
}
