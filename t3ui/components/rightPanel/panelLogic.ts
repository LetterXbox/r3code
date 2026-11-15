// Pure rules for the right panel's surfaces, taken from rightPanelStore.ts and
// useRightPanelActions.ts in the web app. No signals here, so the rules are
// testable without an engine.

/** The surfaces that have one fixed tab: opening them again activates it. */
export type SurfaceKind = "diff" | "files" | "pull-requests";

export type SurfaceTag = "diff" | "files" | "file" | "terminal" | "pull-request" | "pull-requests" | "side-chat" | "preview" | "device";

export type TerminalSplit = "horizontal" | "vertical";

/**
 * A tab (RightPanelSurface in rightPanelStore.ts): the Diff, the Files browser, one file opened from it
 * (id `file:<path>`), a terminal group (`terminal:<id>`), a pull request (`pull-request:<repo>#<n>`),
 * the linked pull requests, a side chat (`side-chat:<threadId>`) or a browser (`browser:<n>`).
 */
export interface Surface {
  id: string;
  kind: SurfaceTag;
  /** Workspace-relative path of a `file` surface. */
  relativePath?: string;
  /** A `file` surface opened at a line (one-based): the preview reveals it. */
  line?: number;
  /** A `file` surface of a chat attachment (id `attachment:<id>`): its path is the attachment's name. */
  attachment?: ChatAttachmentRef;
  /** The deepest path kept after the breadcrumbs moved a file or Files tab up, so the way back down stays shown. */
  folderTrail?: string;
  /** A `terminal` surface: its terminals, the one in front, and how they split. */
  terminalIds?: string[];
  activeTerminalId?: string;
  splitDirection?: TerminalSplit;
  /** A `pull-request` surface. */
  projectId?: string;
  host?: string;
  repository?: string;
  number?: number;
  url?: string;
  /** A `side-chat` surface: the child thread it shows. */
  threadId?: string;
  /** A `preview` surface: the address its browser shows; empty while it has none. */
  previewUrl?: string;
  /** A `preview` surface of a server-hosted tab (runtime "server", serverPreviewSessions.ts): the server's tab id. */
  serverTabId?: string;
  /** A closed `preview` surface: the device viewport it had (reopenClosedView.ts view.snapshot.viewport). */
  viewport?: import("../browser/viewportLogic").ViewportSetting;
  /** A closed server-hosted `preview` surface: the browser profile its session ran in (reopenClosedView.ts profileId). */
  profileId?: string;
  /** A `device` surface: the device it shows (absent on the placeholder that lists devices) and the name the user gave the tab. */
  target?: DeviceTabTarget;
  title?: string;
}

/** DeviceTabTarget (rightPanelStore.ts): the device a tab shows. */
export interface DeviceTabTarget { hostId: string; deviceId: string; platform: "ios" | "android"; name: string }

export interface ChatAttachmentRef { id: string; name: string; mimeType: string; sizeBytes: number; threadId?: string }

export interface PullRequestTarget { projectId: string; host?: string; repository: string; number: number; url?: string }

export interface PanelState {
  /** The right panel is shown (its tab strip and content). */
  open: boolean;
  surfaces: Surface[];
  activeId: string | null;
  width: number;
  maximized: boolean;
  /** The bottom terminal drawer is shown. */
  terminalOpen: boolean;
  /** The thread details card is shown. */
  detailsOpen: boolean;
}

// usePreviewPanelInlineSize.ts
export const PANEL_MIN_WIDTH = 360;
export const PANEL_DEFAULT_WIDTH = 540;
const PANEL_MAX_FRACTION = 0.7;
const SIBLING_COLUMN_MIN_WIDTH = 360;

export const initialPanelState: PanelState = {
  open: false,
  surfaces: [],
  activeId: null,
  width: PANEL_DEFAULT_WIDTH,
  maximized: false,
  terminalOpen: false,
  detailsOpen: false,
};

/** The widest the panel gets: 70% of the window and never so wide the chat column drops under 360. */
export function panelMaxWidth(viewportWidth: number, rowWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PANEL_MAX_FRACTION);
  const rowCap = rowWidth === undefined ? Infinity : Math.floor(rowWidth) - SIBLING_COLUMN_MIN_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(fractionCap, rowCap));
}

/** PR detail defaults to half the full window, constrained by the space beside its list. */
export function pullRequestPanelWidth(initialWidth: number, viewportWidth: number, rowWidth: number): number {
  return Math.min(rowWidth, clampPanelWidth(initialWidth, panelMaxWidth(viewportWidth, rowWidth)));
}

/** Width the chat column keeps beside an inline panel (SIBLING_COLUMN_MIN_WIDTH in usePreviewPanelInlineSize.ts). */
export const CHAT_COLUMN_MIN_WIDTH = SIBLING_COLUMN_MIN_WIDTH;

/** The chat column's width once the panel takes `panelWidth` of a row `rowWidth` wide. */
export function chatColumnWidth(rowWidth: number, panelWidth: number): number {
  return Math.max(0, rowWidth - panelWidth);
}

export function clampPanelWidth(width: number, max: number): number {
  const wanted = Number.isFinite(width) ? width : PANEL_DEFAULT_WIDTH;
  return Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(wanted, max)));
}

/** getTerminalLabel(): `term-3` reads "Terminal 3". */
export function panelTerminalLabel(terminalId: string): string {
  const number = /^term(?:inal)?-(\d+)(?:-.+)?$/i.exec(terminalId)?.[1];
  return number ? `Terminal ${number}` : terminalId;
}

/** Titles from surfaceTitle() in RightPanelTabs.tsx. */
export function surfaceTitle(surface: Surface): string {
  if (surface.kind === "diff") return "Diff";
  if (surface.kind === "files") return "Files";
  if (surface.kind === "terminal") return panelTerminalLabel(surface.activeTerminalId ?? surface.terminalIds?.[0] ?? "");
  if (surface.kind === "pull-request") return `#${surface.number ?? ""}`;
  if (surface.kind === "pull-requests") return "Pull requests";
  if (surface.kind === "side-chat") return "Side chat";
  if (surface.kind === "device") return surface.title ?? surface.target?.name ?? "Device";
  if (surface.kind === "preview") {
    if (!surface.previewUrl) return "Browser";
    try { return new URL(surface.previewUrl).host || "Browser"; } catch { return "Browser"; }
  }
  const path = surface.relativePath ?? "";
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export function fileSurfaceId(relativePath: string): string {
  return `file:${relativePath}`;
}

/** Opens a surface: adds it when absent, makes it active and shows the panel. */
export function openSurface(state: PanelState, kind: SurfaceKind): PanelState {
  return upsert(state, { id: kind, kind });
}

/** Opens a file from the Files browser as its own tab, next to the tabs already open. */
export function openFileSurface(state: PanelState, relativePath: string, line?: number): PanelState {
  const id = fileSurfaceId(relativePath);
  const at = line !== undefined && Number.isInteger(line) && line > 0 ? { line } : {};
  const surfaces = state.surfaces.some((surface) => surface.id === id)
    ? state.surfaces.map((surface) => {
      if (surface.id !== id) return surface;
      const { line: _drop, ...rest } = surface;
      return { ...rest, ...at };
    })
    : [...state.surfaces, { id, kind: "file" as const, relativePath, ...at }];
  return { ...state, open: true, surfaces, activeId: id };
}

/** `openAttachment` (rightPanelStore.ts): a chat attachment opens as its own file tab, in place of the standalone explorer. */
export function openAttachmentSurface(state: PanelState, attachment: ChatAttachmentRef): PanelState {
  const without = { ...state, surfaces: state.surfaces.filter((surface) => surface.kind !== "files") };
  return upsert(without, { id: `attachment:${attachment.id}`, kind: "file", relativePath: attachment.name, attachment });
}

/**
 * `navigateFolder` (rightPanelStore.ts): the breadcrumbs move a tab in place. "" opens the Files tab, anything else a file tab
 * on that path (a folder reads as a folder tab); `folderTrail` keeps the deepest path, `keepSource` leaves the source tab open.
 */
export function navigateFolderSurface(state: PanelState, surfaceId: string, relativePath: string, folderTrail: string, keepSource = false): PanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (index < 0) return state;
  const trail = folderTrail === relativePath ? {} : { folderTrail };
  const target: Surface = relativePath === "" ? { id: "files", kind: "files", ...trail } : { id: fileSurfaceId(relativePath), kind: "file", relativePath, ...trail };
  const source = state.surfaces[index]!;
  const existing = state.surfaces.some((surface, i) => i !== index && surface.id === target.id);
  const surfaces = state.surfaces.flatMap((surface, i) => {
    if (i === index) return keepSource ? (existing ? [source] : [source, target]) : (existing ? [] : [target]);
    return !existing && target.kind === "file" && surface.kind === "files" ? [] : [surface];
  });
  return { ...state, open: true, surfaces, activeId: target.id };
}

function upsert(state: PanelState, surface: Surface): PanelState {
  const surfaces = state.surfaces.some((item) => item.id === surface.id) ? state.surfaces : [...state.surfaces, surface];
  return { ...state, open: true, surfaces, activeId: surface.id };
}

export function terminalSurfaceId(terminalId: string): string {
  return `terminal:${terminalId}`;
}

/** The next `term-N` no terminal of the drawer or the panel uses (they share the server's sessions). */
export function mintTerminalId(state: PanelState, usedElsewhere: readonly string[], suffix?: string): string {
  // allocateTerminalId (useThreadTerminalActions.ts): `term-3` and `term-3-<suffix>` take the same number; the drawer's,
  // the panel's and the server's known sessions are all avoided, and a client without terminal:read adds a random suffix.
  const numberOf = (id: string) => /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(id)?.[1] ?? null;
  const used = new Set([...usedElsewhere, ...state.surfaces.flatMap((surface) => surface.terminalIds ?? [])].map(numberOf).filter((n): n is string => n !== null));
  let counter = 1;
  while (used.has(String(counter))) counter += 1;
  return `term-${counter}${suffix ? `-${suffix}` : ""}`;
}

/** openTerminal: a tab for one terminal, active and the panel shown. */
export function openTerminalSurface(state: PanelState, terminalId: string): PanelState {
  return upsert(state, { id: terminalSurfaceId(terminalId), kind: "terminal", terminalIds: [terminalId], activeTerminalId: terminalId });
}

export const MAX_PANEL_TERMINALS_PER_TAB = 4;

/** splitTerminal: one more terminal in the tab, beside the others (horizontal) or stacked (vertical). */
export function splitTerminalSurface(state: PanelState, surfaceId: string, terminalId: string, direction: TerminalSplit = "horizontal"): PanelState {
  return {
    ...state,
    open: true,
    activeId: surfaceId,
    surfaces: state.surfaces.map((surface) => {
      if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
      const ids = surface.terminalIds ?? [];
      if (ids.length >= MAX_PANEL_TERMINALS_PER_TAB && !ids.includes(terminalId)) return surface;
      const { splitDirection: _drop, ...base } = surface;
      return {
        ...base,
        terminalIds: ids.includes(terminalId) ? ids : [...ids, terminalId],
        activeTerminalId: terminalId,
        ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
      };
    }),
  };
}

export function activateSurfaceTerminal(state: PanelState, surfaceId: string, terminalId: string): PanelState {
  return {
    ...state,
    activeId: surfaceId,
    surfaces: state.surfaces.map((surface) => (surface.id === surfaceId && surface.kind === "terminal" && surface.terminalIds?.includes(terminalId) ? { ...surface, activeTerminalId: terminalId } : surface)),
  };
}

/** closeTerminal: drops one terminal from its tab; the last one takes the tab with it. */
export function closeSurfaceTerminal(state: PanelState, terminalId: string): PanelState {
  const owner = state.surfaces.find((surface) => surface.kind === "terminal" && surface.terminalIds?.includes(terminalId));
  if (!owner) return state;
  const remaining = (owner.terminalIds ?? []).filter((id) => id !== terminalId);
  if (remaining.length === 0) return closeSurface(state, owner.id);
  const index = (owner.terminalIds ?? []).indexOf(terminalId);
  return {
    ...state,
    surfaces: state.surfaces.map((surface) => (surface.id === owner.id
      ? { ...surface, terminalIds: remaining, activeTerminalId: surface.activeTerminalId === terminalId ? remaining[Math.min(index, remaining.length - 1)]! : surface.activeTerminalId }
      : surface)),
  };
}

export function pullRequestSurfaceId(target: { host?: string; repository: string; number: number }): string {
  return `pull-request:${target.host ? `${target.host}/` : ""}${target.repository}#${target.number}`;
}

/** openPullRequest: one tab per pull request. */
export function openPullRequestSurface(state: PanelState, target: PullRequestTarget): PanelState {
  return upsert(state, {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    projectId: target.projectId,
    ...(target.host ? { host: target.host } : {}),
    repository: target.repository,
    number: target.number,
    ...(target.url ? { url: target.url } : {}),
  });
}

export function openPullRequestsSurface(state: PanelState): PanelState {
  return upsert(state, { id: "pull-requests", kind: "pull-requests" });
}

/** The id of a device tab: the placeholder `device` until a device is chosen, then `device:<host>:<device>` (rightPanelStore openDevice). */
export function deviceSurfaceId(target: Pick<DeviceTabTarget, "hostId" | "deviceId">): string {
  return `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}`;
}

/** The launcher's Device: the placeholder tab that lists devices. */
export function openDevicePlaceholder(state: PanelState): PanelState {
  return upsert(state, { id: "device", kind: "device" });
}

/** openDevice: the placeholder becomes the device's tab; a tab for that device already open is shown instead. */
export function openDeviceSurface(state: PanelState, target: DeviceTabTarget): PanelState {
  const id = deviceSurfaceId(target);
  const surface: Surface = { id, kind: "device", target };
  const existing = state.surfaces.find((item) => item.id === id);
  const surfaces = existing
    ? state.surfaces.filter((item) => item.id !== "device")
    : state.surfaces.map((item) => (item.id === "device" ? surface : item));
  return upsert({ ...state, surfaces }, existing ?? surface);
}

/** renameDevice: an empty name goes back to the device's own. */
export function renameDeviceSurface(state: PanelState, id: string, title: string): PanelState {
  return {
    ...state,
    surfaces: state.surfaces.map((surface) => {
      if (surface.id !== id || surface.kind !== "device") return surface;
      const name = title.trim() || surface.target?.name || "Device";
      return { ...surface, title: name };
    }),
  };
}

export function sideChatSurfaceId(threadId: string): string {
  return `side-chat:${threadId}`;
}

export function openSideChatSurface(state: PanelState, threadId: string): PanelState {
  return upsert(state, { id: sideChatSurfaceId(threadId), kind: "side-chat", threadId });
}

/** openBrowser: a tab for a new browser, or the one with this id. */
export function openPreviewSurface(state: PanelState, id: string, previewUrl = ""): PanelState {
  return upsert(state, { id, kind: "preview", ...(previewUrl ? { previewUrl } : {}) });
}

export function nextPreviewId(state: PanelState): string {
  let counter = 1;
  while (state.surfaces.some((surface) => surface.id === `browser:${counter}`)) counter += 1;
  return `browser:${counter}`;
}

export function setPreviewUrl(state: PanelState, id: string, previewUrl: string): PanelState {
  return { ...state, surfaces: state.surfaces.map((surface) => (surface.id === id && surface.kind === "preview" ? { ...surface, previewUrl } : surface)) };
}

/** `diff.toggle`: closes the diff surface when it is the one showing, else opens it. */
export function toggleSurface(state: PanelState, kind: SurfaceKind): PanelState {
  if (state.open && state.activeId === kind) return closeSurface(state, kind);
  return openSurface(state, kind);
}

export function activateSurface(state: PanelState, id: string): PanelState {
  return state.surfaces.some((surface) => surface.id === id) ? { ...state, activeId: id } : state;
}

function afterRemoval(state: PanelState, surfaces: Surface[], previousIndex: number): PanelState {
  const activeStays = state.activeId !== null && surfaces.some((surface) => surface.id === state.activeId);
  const next = surfaces[Math.min(Math.max(previousIndex, 0), surfaces.length - 1)];
  return {
    ...state,
    surfaces,
    // Closing the last tab keeps the panel open on its "Open a surface" launcher.
    activeId: activeStays ? state.activeId : (next?.id ?? null),
    maximized: surfaces.length === 0 ? false : state.maximized,
  };
}

export function closeSurface(state: PanelState, id: string): PanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index < 0) return state;
  return afterRemoval(state, state.surfaces.filter((surface) => surface.id !== id), index);
}

export function closeOtherSurfaces(state: PanelState, id: string): PanelState {
  const keep = state.surfaces.filter((surface) => surface.id === id);
  return afterRemoval({ ...state, activeId: keep.length ? id : state.activeId }, keep, 0);
}

export function closeSurfacesToRight(state: PanelState, id: string): PanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index < 0) return state;
  return afterRemoval(state, state.surfaces.slice(0, index + 1), index);
}

export function closeAllSurfaces(state: PanelState): PanelState {
  return afterRemoval(state, [], 0);
}

/** `rightPanel.toggle`: hides or shows the panel, keeping its tabs. */
export function toggleRightPanel(state: PanelState): PanelState {
  return { ...state, open: !state.open, maximized: state.open ? false : state.maximized };
}

export function toggleMaximized(state: PanelState): PanelState {
  return state.open && state.surfaces.length > 0 ? { ...state, maximized: !state.maximized } : state;
}

export function toggleTerminal(state: PanelState): PanelState {
  return { ...state, terminalOpen: !state.terminalOpen };
}

export function toggleDetails(state: PanelState): PanelState {
  return { ...state, detailsOpen: !state.detailsOpen };
}

/** Reads one persisted state defensively: stored text can be old or hand-edited. */
export function readPanelState(value: unknown, maxWidth = 4000): PanelState {
  if (typeof value !== "object" || value === null) return initialPanelState;
  const raw = value as Record<string, unknown>;
  const surfaces: Surface[] = [];
  if (Array.isArray(raw.surfaces)) {
    for (const item of raw.surfaces) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      let surface: Surface | null = null;
      const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
      if (entry.kind === "diff" || entry.kind === "files" || entry.kind === "pull-requests") surface = { id: entry.kind, kind: entry.kind };
      else if (entry.kind === "file" && typeof entry.attachment === "object" && entry.attachment !== null && typeof (entry.attachment as Record<string, unknown>).id === "string") {
        const saved = entry.attachment as Record<string, unknown>;
        const name = text(saved.name) ?? "Attachment";
        surface = { id: `attachment:${saved.id as string}`, kind: "file", relativePath: name, attachment: { id: saved.id as string, name, mimeType: text(saved.mimeType) ?? "application/octet-stream", sizeBytes: typeof saved.sizeBytes === "number" ? saved.sizeBytes : 0, ...(text(saved.threadId) ? { threadId: text(saved.threadId) } : {}) } };
      } else if (entry.kind === "file" && typeof entry.relativePath === "string" && entry.relativePath) {
        surface = { id: fileSurfaceId(entry.relativePath), kind: "file", relativePath: entry.relativePath, ...(text(entry.folderTrail) ? { folderTrail: text(entry.folderTrail)! } : {}) };
      } else if (entry.kind === "terminal" && Array.isArray(entry.terminalIds)) {
        const ids = entry.terminalIds.filter((id): id is string => typeof id === "string" && /^term-\d+(?:-[A-Za-z0-9-]+)?$/.test(id)).slice(0, MAX_PANEL_TERMINALS_PER_TAB);
        if (ids.length > 0) {
          const front = typeof entry.activeTerminalId === "string" && ids.includes(entry.activeTerminalId) ? entry.activeTerminalId : ids[0]!;
          surface = { id: terminalSurfaceId(ids[0]!), kind: "terminal", terminalIds: ids, activeTerminalId: front, ...(entry.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}) };
        }
      } else if (entry.kind === "pull-request" && text(entry.projectId) && text(entry.repository) && typeof entry.number === "number" && Number.isInteger(entry.number)) {
        const target: PullRequestTarget = { projectId: text(entry.projectId)!, repository: text(entry.repository)!, number: entry.number, ...(text(entry.host) ? { host: text(entry.host)! } : {}), ...(text(entry.url) ? { url: text(entry.url)! } : {}) };
        surface = { id: pullRequestSurfaceId(target), kind: "pull-request", ...target };
      } else if (entry.kind === "side-chat" && text(entry.threadId)) {
        surface = { id: sideChatSurfaceId(text(entry.threadId)!), kind: "side-chat", threadId: text(entry.threadId)! };
      } else if (entry.kind === "device" && typeof entry.id === "string" && (entry.id === "device" || entry.id.startsWith("device:"))) {
        const raw = typeof entry.target === "object" && entry.target !== null ? (entry.target as Record<string, unknown>) : null;
        const target: DeviceTabTarget | null = raw && text(raw.hostId) && text(raw.deviceId) && (raw.platform === "ios" || raw.platform === "android") && text(raw.name)
          ? { hostId: text(raw.hostId)!, deviceId: text(raw.deviceId)!, platform: raw.platform, name: text(raw.name)! }
          : null;
        surface = { id: target ? deviceSurfaceId(target) : "device", kind: "device", ...(target ? { target } : {}), ...(text(entry.title) ? { title: text(entry.title)! } : {}) };
      } else if (entry.kind === "preview" && typeof entry.id === "string" && /^browser:\d+$/.test(entry.id)) {
        surface = { id: entry.id, kind: "preview", ...(text(entry.previewUrl) ? { previewUrl: text(entry.previewUrl)! } : {}) };
      }
      if (surface && !surfaces.some((existing) => existing.id === surface.id)) surfaces.push(surface);
    }
  }
  const activeId = surfaces.some((surface) => surface.id === raw.activeId) ? (raw.activeId as string) : (surfaces[0]?.id ?? null);
  return {
    open: raw.open === true,
    surfaces,
    activeId,
    width: typeof raw.width === "number" ? clampPanelWidth(raw.width, maxWidth) : PANEL_DEFAULT_WIDTH,
    maximized: raw.maximized === true && surfaces.length > 0,
    terminalOpen: raw.terminalOpen === true,
    detailsOpen: false,
  };
}

/** rightPanelLayout.ts: RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY is "(max-width: 980px)". */
export const RIGHT_PANEL_SHEET_MAX_WIDTH = 980;

/** ChatView's shouldUsePlanSidebarSheet: narrow windows show the panel as a sheet, unless it is maximized. */
export function usesPanelSheet(windowWidth: number, maximized: boolean): boolean {
  return windowWidth <= RIGHT_PANEL_SHEET_MAX_WIDTH && !maximized;
}

/** RightPanelSheet.tsx: `w-[min(42vw,28rem)] min-w-80 max-w-[28rem]`, and `w-[min(88vw,24rem)] min-w-0` at 760px and under. */
export function panelSheetWidth(windowWidth: number): number {
  if (windowWidth <= 760) return Math.round(Math.min(windowWidth * 0.88, 384));
  return Math.round(Math.max(320, Math.min(windowWidth * 0.42, 448)));
}

/** rightPanelStore.moveSurface: the tab moves to `toIndex` of the list. */
export function moveSurface(state: PanelState, id: string, toIndex: number): PanelState {
  const from = state.surfaces.findIndex((surface) => surface.id === id);
  if (from < 0 || from === toIndex || toIndex < 0 || toIndex >= state.surfaces.length) return state;
  const surfaces = [...state.surfaces];
  surfaces.splice(toIndex, 0, ...surfaces.splice(from, 1));
  return { ...state, surfaces };
}

export interface TabSlot { id: string; x: number; width: number }

/**
 * SortableTabList's closestCenter: the index of the tab whose centre is nearest the
 * dragged tab's centre once it has moved `translationX`. Null when nothing moves.
 */
export function dragTargetIndex(slots: readonly TabSlot[], draggedId: string, translationX: number): number | null {
  const from = slots.findIndex((slot) => slot.id === draggedId);
  if (from < 0) return null;
  const dragged = slots[from]!;
  const centre = dragged.x + dragged.width / 2 + translationX;
  let best = from;
  let bestDistance = Infinity;
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.x + slot.width / 2 - centre);
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  });
  return best === from ? null : best;
}

/**
 * rightPanelStore reconcileFileSurfaces: a thread whose workspace is gone (no project) drops its Files tab and its file
 * tabs, keeping attachments; the active tab falls back to the last one left and an empty panel closes.
 */
export function reconcileFileSurfaces(state: PanelState, workspaceAvailable: boolean): PanelState {
  if (workspaceAvailable) return state;
  const surfaces = state.surfaces.filter((surface) => surface.kind !== "files" && (surface.kind !== "file" || (surface as { attachment?: unknown }).attachment !== undefined));
  if (surfaces.length === state.surfaces.length) return state;
  const activeStillExists = surfaces.some((surface) => surface.id === state.activeId);
  return { ...state, open: surfaces.length > 0 ? state.open : false, surfaces, activeId: activeStillExists ? state.activeId : (surfaces.at(-1)?.id ?? null) };
}
