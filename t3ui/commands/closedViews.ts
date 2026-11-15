// view.reopenClosed (mod+shift+t): brings back the right panel tab that was closed last, as a browser reopens a tab
// (closedViewStore.ts, reopenClosedView.ts and ReopenClosedViewShortcut.tsx in the web app). A tab that leaves the panel
// of the open thread is remembered (newest first, at most 20; terminals are not, they have a session of their own);
// the shortcut restores the newest one that is not already open, on its own thread.
import { effect, signal, Storage, untracked } from "nsh";
import { currentPanelKey, panelStateFor, updatePanel } from "../components/rightPanel/panelState";
import type { Surface } from "../components/rightPanel/panelLogic";
import { isViewportSetting, tabViewport } from "../components/rightPanel/previewViewportMemory";
import { allThreads, backendStatus, openThread, openThreadById, requestBackend } from "../store";
import { serverPreviewFor, serverSurfaceId } from "../components/rightPanel/serverPreviewSessions";

let openRequest: (method: string, payload: unknown) => Promise<unknown> = requestBackend;
/** Tests only: where a reopened server tab's preview.open goes. */
export function setReopenRequestForTest(request: ((method: string, payload: unknown) => Promise<unknown>) | null) { openRequest = request ?? requestBackend; }
import { registerCommand } from "./registry";

export interface ClosedViewEntry { id: string; panelKey: string; surface: Surface }

const MAX_ENTRIES = 20;
const STORAGE_KEY = "closedViews";
const entries = signal<ClosedViewEntry[]>([]);
let counter = 0;

// closedViewStore.ts:56-111: a saved entry is kept only when its surface has the fields its kind needs.
const KIND_FIELDS: Record<string, readonly string[]> = { file: ["relativePath"], "side-chat": ["threadId"], "pull-request": ["repository", "number"] };
export function isValidClosedView(item: unknown): item is ClosedViewEntry {
  const entry = item as Partial<ClosedViewEntry> | null;
  if (!entry || typeof entry.id !== "string" || typeof entry.panelKey !== "string" || typeof entry.surface?.id !== "string" || typeof entry.surface.kind !== "string") return false;
  const surface = entry.surface as unknown as Record<string, unknown>;
  if (surface.viewport !== undefined && !isViewportSetting(surface.viewport)) return false;
  return (KIND_FIELDS[entry.surface.kind] ?? []).every((field) => surface[field] !== undefined && surface[field] !== null && surface[field] !== "");
}

/** Newest first. */
export const closedViews = () => entries();
export const hasClosedViews = () => entries().length > 0;

function persist() {
  void Storage.setItem(STORAGE_KEY, JSON.stringify(entries())).catch(() => undefined);
}

void Storage.getItem(STORAGE_KEY).then((text) => {
  if (!text) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return;
    const saved = parsed.filter(isValidClosedView);
    // What was closed before storage answered stays in front of the saved copy.
    entries.update((current) => [...current, ...saved.filter((item) => !current.some((existing) => existing.id === item.id))].slice(0, MAX_ENTRIES));
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => undefined);

/** remember: the same tab closed twice is kept once, in front. */
export function rememberClosedView(panelKey: string, surface: Surface) {
  if (surface.kind === "terminal") return;
  // A browser tab keeps its device viewport (reopenClosedView.ts:122-140).
  if (surface.kind === "preview") { const viewport = tabViewport(surface.id); if (viewport) surface = { ...surface, viewport }; }
  // ...and a server-hosted one the browser profile its session ran in.
  if (surface.kind === "preview" && surface.serverTabId) {
    const threadId = threadIdOfPanelKey(panelKey);
    const profileId = threadId ? serverPreviewFor(threadId).sessions[surface.serverTabId]?.profileId : undefined;
    if (profileId) surface = { ...surface, profileId };
  }
  const id = `closed:${Date.now()}:${++counter}`;
  entries.update((all) => [{ id, panelKey, surface }, ...all.filter((entry) => !(entry.panelKey === panelKey && entry.surface.id === surface.id))].slice(0, MAX_ENTRIES));
  persist();
}

export function clearClosedViews() {
  entries.set([]);
  persist();
}

/** What planNextReopen needs to know about an entry's owner (ReopenOwnerState). */
export interface ReopenOwner { shellLive: boolean; ownerExists: boolean; sideChatExists: boolean; isOpen: boolean }

/** planNextReopen (reopenClosedView.ts:25-55): tabs open again are dropped; an entry whose thread (or side chat) is gone
 * is skipped while the shell is live, and waits (the plan stops) while it is not, so nothing is lost to a reconnect; the
 * first entry left is the one to restore. */
export function planNextReopen(all: readonly ClosedViewEntry[], owner: (entry: ClosedViewEntry) => ReopenOwner | boolean): { drop: ClosedViewEntry[]; restore: ClosedViewEntry | null } {
  const drop: ClosedViewEntry[] = [];
  for (const entry of all) {
    const raw = owner(entry);
    const state: ReopenOwner = typeof raw === "boolean" ? { shellLive: true, ownerExists: true, sideChatExists: true, isOpen: raw } : raw;
    if (!state.ownerExists || !state.sideChatExists) {
      if (state.shellLive) continue;
      break;
    }
    if (state.isOpen) { drop.push(entry); continue; }
    return { drop, restore: entry };
  }
  return { drop, restore: null };
}

/** The thread a panel key belongs to (panelKeyFor: [backend url, thread id]). */
export function threadIdOfPanelKey(panelKey: string): string | null {
  try {
    const parsed: unknown = JSON.parse(panelKey);
    return Array.isArray(parsed) && typeof parsed[1] === "string" ? parsed[1] : null;
  } catch { return null; }
}

/** Restores the newest closed tab onto its thread's panel and opens that thread. True when one came back. */
export function reopenClosedView(): boolean {
  const threadExists = (id: string | null | undefined) => !!id && (allThreads().some((thread) => thread.id === id) || openThread()?.id === id);
  const { drop, restore } = planNextReopen(entries(), (entry) => {
    const state = panelStateFor(entry.panelKey);
    return {
      shellLive: backendStatus() === "connected",
      // The thread is known to the shell, or still has its panel (a deleted thread's panel is forgotten with it).
      ownerExists: threadExists(threadIdOfPanelKey(entry.panelKey)) || state !== panelStateFor(null),
      sideChatExists: entry.surface.kind !== "side-chat" || threadExists(entry.surface.threadId),
      isOpen: state.open && state.surfaces.some((surface) => surface.id === entry.surface.id),
    };
  });
  if (drop.length > 0 || restore) {
    const gone = new Set([...drop, ...(restore ? [restore] : [])].map((entry) => entry.id));
    entries.update((all) => all.filter((entry) => !gone.has(entry.id)));
    persist();
  }
  if (!restore) return false;
  const surface = restore.surface;
  const threadOfEntry = threadIdOfPanelKey(restore.panelKey);
  // A server-hosted browser tab comes back as a new session with its URL, viewport and profile (reopenClosedView.ts:104-115
  // openPreviewSession); the server's tab list then adds its panel tab, which is brought to the front.
  if (surface.kind === "preview" && surface.serverTabId && threadOfEntry) {
    const viewport = surface.viewport ? (surface.viewport.kind === "fill" ? { _tag: "fill" } : { ...surface.viewport, _tag: surface.viewport.kind, kind: undefined }) : undefined;
    void openRequest("preview.open", {
      threadId: threadOfEntry, runtime: "server",
      ...(surface.previewUrl ? { url: surface.previewUrl } : {}),
      ...(viewport ? { viewport } : {}),
      ...(surface.profileId ? { profileId: surface.profileId } : {}),
    }).then((snapshot) => {
      const tabId = (snapshot as { tabId?: unknown } | null)?.tabId;
      if (typeof tabId !== "string") return;
      updatePanel(restore.panelKey, (state) => ({ ...state, open: true, activeId: serverSurfaceId(tabId) }));
    }).catch(() => {});
    openThreadById(threadOfEntry);
    return true;
  }
  updatePanel(restore.panelKey, (state) => ({
    ...state,
    open: true,
    surfaces: state.surfaces.some((candidate) => candidate.id === surface.id) ? state.surfaces : [...state.surfaces, surface],
    activeId: surface.id,
  }));
  const threadId = threadIdOfPanelKey(restore.panelKey);
  if (threadId) openThreadById(threadId);
  return true;
}

let installed = false;

/** Watches the open thread's panel for tabs that close, and binds view.reopenClosed. Once, at startup. */
export function installClosedViews() {
  if (installed) return;
  installed = true;
  let watching: string | null = null;
  let known: Surface[] = [];
  effect(() => {
    const key = currentPanelKey();
    const surfaces = key ? panelStateFor(key).surfaces : [];
    untracked(() => {
      if (key !== watching) { watching = key; known = surfaces; return; }
      if (key) for (const surface of known) if (!surfaces.some((candidate) => candidate.id === surface.id)) rememberClosedView(key, surface);
      known = surfaces;
    });
  });
  registerCommand("view.reopenClosed", () => { if (!hasClosedViews()) return false; return reopenClosedView(); });
}
