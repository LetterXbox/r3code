// Per-thread right panel state, remembered across restarts. The rules live in
// panelLogic.ts; this holds the signals and the saved copy.
import { closeSurfacesAndRelease, surfaceCloseDeps } from "./surfaceClose";
import { effect, signal, Storage, untracked, windowSize } from "nsh";
import { sidebarWidth } from "../sidebar/sidebarWidth";
import { allProjects, backendUrl, isServerThread, openThread } from "../../store";
import { drawerStateFor } from "../terminal/drawerState";
import { allTerminalIds } from "../terminal/terminalLogic";
import { allocationFor } from "../terminal/terminalAllocation";
import {
  activateSurfaceTerminal, closeSurfaceTerminal, mintTerminalId, nextPreviewId, openIssueSurface as openIssueSurfaceState, openPreviewSurface, openPullRequestsSurface, openPullRequestSurface as openPullRequestSurfaceState,
  openSideChatSurface, openTerminalSurface, setPreviewUrl, splitTerminalSurface, type IssueSurfaceTarget, type PullRequestTarget, type TerminalSplit,
  openDevicePlaceholder, openDeviceSurface, renameDeviceSurface, type DeviceTabTarget,
  openAttachmentSurface, navigateFolderSurface, reconcileFileSurfaces, type ChatAttachmentRef,
  closeSurface, initialPanelState, panelMaxWidth, moveSurface, openFileSurface, openSurface, readPanelState, toggleDetails, toggleMaximized, toggleRightPanel, toggleSurface, toggleTerminal, usesPanelSheet,
  type PanelState, type SurfaceKind,
} from "./panelLogic";
import { closeMiniPlayer, miniPlayerFor, openDeviceMiniPlayer, openMiniPlayer, pruneMiniPlayer } from "./miniPlayerState";
import { knownDeviceState } from "../device/deviceState";
import { hasLiveDeviceSession } from "./agentOpenedDevices";

const STORAGE_KEY = "rightPanels";
const states = signal<Record<string, PanelState>>({});
let loaded = false;

function persist() {
  const saved: Record<string, unknown> = {};
  for (const [key, state] of Object.entries(states())) saved[key] = { ...state, detailsOpen: false };
  void Storage.setItem(STORAGE_KEY, JSON.stringify(saved)).catch(() => {});
}

void Storage.getItem(STORAGE_KEY).then((text) => {
  if (loaded || !text) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return;
    const next: Record<string, PanelState> = {};
    // A saved width that no longer fits this window (or was never valid) is corrected on load.
    const fit = panelMaxWidth(windowSize().width - sidebarWidth());
    for (const [key, value] of Object.entries(parsed)) next[key] = readPanelState(value, fit);
    // Anything the user changed before storage answered wins over the saved copy.
    states.update((current) => ({ ...next, ...current }));
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => {}).finally(() => { loaded = true; });

export function panelKeyFor(threadId: string): string {
  return JSON.stringify([backendUrl(), threadId]);
}

type PanelContext = { key: string | null; workspace: { threadId: string; cwd: string | null } | null };
// A signal, so a fixture can switch threads while the panel is mounted (webViewIdentity.test.tsx).
const overrideContext = signal<PanelContext | null>(null);

/** Tests give the panel a thread without a server behind it. Pass null to go back to the store. */
export function overridePanelContext(context: PanelContext | null) {
  overrideContext.set(context);
}

/** The key of the open server thread, or null when no panel applies. */
export function currentPanelKey(): string | null {
  const override = overrideContext();
  if (override) return override.key;
  const thread = openThread();
  // A new thread that has no message yet has its panel too, as the reference keys it by the draft's thread ref (a link
  // opened from the OS starts one, DesktopWebLinkCoordinator startThread); it keeps the key when the server takes it.
  return thread ? panelKeyFor(thread.id) : null;
}

export function panelStateFor(key: string | null): PanelState {
  return (key ? states()[key] : undefined) ?? initialPanelState;
}

export function updatePanel(key: string, change: (state: PanelState) => PanelState) {
  states.update((current) => ({ ...current, [key]: change(current[key] ?? initialPanelState) }));
  // followPreviewSessions: a floating browser tab that was closed stops floating.
  pruneMiniPlayer(key, panelStateFor(key).surfaces.filter((surface) => surface.kind === "preview").map((surface) => surface.id));
  persist();
}

/** useThreadActions delete: a deleted thread's panel tabs and floating card go with it. */
export function forgetThreadPanel(threadId: string) {
  const key = panelKeyFor(threadId);
  closeMiniPlayer(key);
  if (states()[key] === undefined) return;
  states.update((current) => { const { [key]: _gone, ...rest } = current; return rest; });
  persist();
}

export function setPanelWidth(key: string, width: number) {
  updatePanel(key, (state) => ({ ...state, width }));
}

/** The open thread's project folder: what Files browses and the terminal opens in. */
export function currentWorkspace(): { threadId: string; cwd: string | null } | null {
  const override = overrideContext();
  if (override) return override.workspace;
  const thread = openThread();
  if (!thread) return null;
  const project = allProjects().find((item) => item.id === thread.projectId);
  // Before its first message the server has no such thread; it has its project's folder (the reference keys the panel by
  // the draft's thread ref, and a link opened from the OS starts one in the Scratch project).
  if (!isServerThread(thread.id)) return project?.path ? { threadId: thread.id, cwd: project.path } : null;
  return { threadId: thread.id, cwd: thread.path ?? project?.path ?? null };
}

/** Surface availability, with the web's SURFACE_UNAVAILABLE_HINTS for the unavailable ones. */
export function surfaceAvailability() {
  const workspace = currentWorkspace();
  return {
    diff: workspace !== null && workspace.cwd !== null,
    files: workspace !== null && workspace.cwd !== null,
    terminal: workspace !== null && workspace.cwd !== null,
    rightPanel: workspace !== null,
  };
}

function act(change: (state: PanelState) => PanelState) {
  const key = currentPanelKey();
  if (key) updatePanel(key, change);
}

/**
 * closePreviewPanel (useRightPanelActions.ts): a panel that closes while a browser tab is in front leaves that tab floating
 * over the chat. A tab with no page yet has nothing to float.
 */
function floatActivePreview(key: string) {
  const state = panelStateFor(key);
  if (!state.open) return;
  const active = state.surfaces.find((surface) => surface.id === state.activeId);
  if (active?.kind === "preview" && (active.previewUrl ?? "") !== "") openMiniPlayer(key, active.id);
  // floatDeviceSurface: a device tab floats its stream; one whose session already ended has nothing to stream. Before
  // the first device snapshot it floats, and that snapshot closes it if needed.
  else if (active?.kind === "device" && active.target) {
    const known = knownDeviceState();
    const threadId = currentWorkspace()?.threadId;
    if (known !== null && (!threadId || !hasLiveDeviceSession(known, threadId, active.target))) return;
    openDeviceMiniPlayer(key, active.id, active.target);
  }
}

export const toggleRightPanelAction = () => {
  if (!surfaceAvailability().rightPanel) return;
  const key = currentPanelKey();
  if (key) floatActivePreview(key);
  act(toggleRightPanel);
};
export const toggleDiffAction = () => { if (surfaceAvailability().diff) act((state) => toggleSurface(state, "diff")); };
export const toggleTerminalAction = () => { if (surfaceAvailability().terminal) act(toggleTerminal); };
/**
 * The key the thread details card's open state lives under: a draft has one too, since the card hosts its workspace pickers
 * before the first message (ThreadDetailsPanel takes a `draftId`). Everything else about a draft has no panel.
 */
export function detailsPanelKey(): string | null {
  const override = overrideContext();
  if (override) return override.key;
  const thread = openThread();
  return thread ? panelKeyFor(thread.id) : null;
}
export const toggleDetailsAction = () => { const key = detailsPanelKey(); if (key) updatePanel(key, toggleDetails); };
export const toggleMaximizedAction = () => act(toggleMaximized);
export const openSurfaceAction = (kind: SurfaceKind) => act((state) => openSurface(state, kind));
export const openAttachmentAction = (attachment: ChatAttachmentRef) => act((state) => openAttachmentSurface(state, attachment));
export const navigateFolderAction = (surfaceId: string, relativePath: string, folderTrail: string, keepSource = false) => act((state) => navigateFolderSurface(state, surfaceId, relativePath, folderTrail, keepSource));
export const openFileAction = (relativePath: string, line?: number) => act((state) => openFileSurface(state, relativePath, line));
export const moveSurfaceAction = (id: string, toIndex: number) => act((state) => moveSurface(state, id, toIndex));
export const closeRightPanelAction = () => {
  const key = currentPanelKey();
  if (key) floatActivePreview(key);
  act((state) => (state.open ? { ...state, open: false, maximized: false } : state));
};

/** PreviewView.tsx handlePictureInPicture ("Float preview over chat" / "Close floating preview" in the browser's toolbar). */
export function togglePreviewFloatAction(tabId: string) {
  const key = currentPanelKey();
  if (!key) return;
  if (miniPlayerFor(key)?.tabId === tabId) { closeMiniPlayer(key); return; }
  openMiniPlayer(key, tabId);
  act((state) => (state.open ? { ...state, open: false, maximized: false } : state));
}

/** ThreadPreviewMiniPlayer.tsx openInPanel ("Open in right panel"): the floating tab goes back to the panel, in front. */
export function dockMiniPlayerAction() {
  const key = currentPanelKey();
  const tabId = miniPlayerFor(key)?.tabId;
  if (!key || !tabId) return;
  const device = miniPlayerFor(key)?.device;
  closeMiniPlayer(key);
  // DeviceMiniPlayer openInPanel: the device opens as a tab (openDevice), whether or not it had one.
  if (device) { act((state) => { const next = openDeviceSurface(state, device); return { ...next, open: true, activeId: tabId }; }); return; }
  act((state) => (state.surfaces.some((surface) => surface.id === tabId) ? { ...state, open: true, activeId: tabId } : state));
}

/** "Close floating preview": the tab stays in the panel's tab list, with its page. */
export function closeMiniPlayerAction() {
  const key = currentPanelKey();
  if (key) closeMiniPlayer(key);
}

/** The panel shows as a sheet over the chat: a narrow window and not maximized (ChatView's shouldUsePlanSidebarSheet). */
export function panelSheetActive(): boolean {
  return usesPanelSheet(windowSize().width, panelStateFor(currentPanelKey()).maximized);
}

/** `rightPanel.close` (mod+w): closes the active tab; with none left, hides the panel. */
export const closeActiveSurfaceAction = () => {
  const key = currentPanelKey();
  if (!key) return;
  const state = panelStateFor(key);
  if (!state.open) return;
  if (state.activeId === null) { updatePanel(key, (current) => ({ ...current, open: false, maximized: false })); return; }
  const activeId = state.activeId;
  const deps = surfaceCloseDeps();
  // useRightPanelSurfaceClose: the tab releases its terminals / side chat / server session (surfaceClose.ts).
  if (!deps) { updatePanel(key, (current) => closeSurface(current, activeId)); return; }
  void closeSurfacesAndRelease({ threadId: currentWorkspace()?.threadId ?? null, state: () => panelStateFor(key), apply: (change) => updatePanel(key, change), change: (current) => closeSurface(current, activeId), single: state.surfaces.find((surface) => surface.id === activeId), deps });
};


/** Terminals of the drawer and the panel share the server's sessions, so a new id avoids both. */
function usedTerminalIds(): string[] {
  const key = currentPanelKey();
  const threadId = currentWorkspace()?.threadId;
  return [...(key ? allTerminalIds(drawerStateFor(key)) : []), ...(threadId ? allocationFor(threadId).used ?? [] : [])];
}
/** Without terminal:read the server's sessions are unseen, so a new panel terminal takes a random suffix (allocationFor). */
function terminalSuffix(): string | undefined {
  const threadId = currentWorkspace()?.threadId;
  return threadId ? allocationFor(threadId).suffix : undefined;
}

/** The launcher's Terminal: a terminal tab in the panel. */
export const openTerminalSurfaceAction = () => { if (surfaceAvailability().terminal) act((state) => openTerminalSurface(state, mintTerminalId(state, usedTerminalIds(), terminalSuffix()))); };
/** Opens the thread's terminal `terminalId` (a worktree setup script's terminal). */
export const openTerminalIdAction = (terminalId: string) => { if (surfaceAvailability().terminal) act((state) => openTerminalSurface(state, terminalId)); };
export const splitPanelTerminalAction = (surfaceId: string, direction: TerminalSplit = "horizontal") => act((state) => splitTerminalSurface(state, surfaceId, mintTerminalId(state, usedTerminalIds(), terminalSuffix()), direction));
export const activatePanelTerminalAction = (surfaceId: string, terminalId: string) => act((state) => activateSurfaceTerminal(state, surfaceId, terminalId));
export const closePanelTerminalAction = (terminalId: string) => act((state) => closeSurfaceTerminal(state, terminalId));
export const openBrowserAction = (url = "") => act((state) => openPreviewSurface(state, nextPreviewId(state), url));
/** A link the page opened itself (previewLinks.ts): a new browser tab; a background one leaves the front tab in front. */
export const openPageLinkAction = (url: string, background: boolean) => act((state) => {
  const next = openPreviewSurface(state, nextPreviewId(state), url);
  return background && state.activeId !== null ? { ...next, activeId: state.activeId } : next;
});
export const setPreviewUrlAction = (id: string, url: string) => act((state) => setPreviewUrl(state, id, url));
/** Opens one pull request as its own tab ("Show linked pull requests" and the details card's rows use it). */
export const openPullRequestSurface = (target: PullRequestTarget) => act((state) => openPullRequestSurfaceState(state, target));
export const openIssueSurface = (target: IssueSurfaceTarget) => act((state) => openIssueSurfaceState(state, target));
export const openPullRequestsAction = () => act(openPullRequestsSurface);
export const openSideChatAction = (threadId: string) => act((state) => openSideChatSurface(state, threadId));
/** The launcher's Device (when device support is set up): the placeholder tab that lists devices. */
export const openDevicePlaceholderAction = () => act(openDevicePlaceholder);
/** A device was opened for the thread: its own tab, in place of the placeholder. */
export const openDeviceAction = (target: DeviceTabTarget) => act((state) => openDeviceSurface(state, target));
export const renameDeviceAction = (id: string, title: string) => act((state) => renameDeviceSurface(state, id, title));

/** rightPanelStore pendingMaximizeThreadKey: a panel asked to open maximized once it can (a link opened into a new thread). */
const pendingMaximizeKey = signal<string | null>(null);
/** requestMaximize. */
export function requestPanelMaximize(key: string) { pendingMaximizeKey.set(key); }
/** consumeMaximizeRequest: true once for the panel that asked, clearing the request. */
export function consumePanelMaximizeRequest(key: string): boolean {
  if (pendingMaximizeKey() !== key) return false;
  pendingMaximizeKey.set(null);
  return true;
}
/** ChatView's effect: when the requested panel is the open one and has a tab to maximize, it maximizes. */
export function applyPendingMaximize(): boolean {
  const key = currentPanelKey();
  if (!key || pendingMaximizeKey() !== key || panelStateFor(key).surfaces.length === 0) return false;
  if (!consumePanelMaximizeRequest(key)) return false;
  updatePanel(key, (state) => ({ ...state, open: true, maximized: true }));
  return true;
}

let reconcileInstalled = false;
/** ChatView: once the shell is loaded, the open thread's file tabs go when its project does (reconcileFileSurfaces). */
export function installFileSurfaceReconcile(shellLoaded: () => boolean) {
  if (reconcileInstalled) return;
  reconcileInstalled = true;
  effect(() => {
    const thread = openThread();
    const key = currentPanelKey();
    if (!thread || !key || !shellLoaded()) return;
    const workspaceAvailable = !!thread.projectId && allProjects().some((project) => project.id === thread.projectId);
    untracked(() => {
      const current = panelStateFor(key);
      const next = reconcileFileSurfaces(current, workspaceAvailable);
      if (next !== current) updatePanel(key, () => next);
    });
  });
}
