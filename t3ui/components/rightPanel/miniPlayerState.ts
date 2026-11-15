// The floating browser preview ("mini player"): a browser tab of the right panel shown as a card over the chat while
// its panel is closed or shows another tab. A port of the reference's previewMiniPlayerStore.ts (one entry per
// thread: which tab floats, where, how wide, and whether it was last dragged or resized) and of
// shouldRenderPreviewMiniPlayer (ChatView.logic.ts). Like the reference's store it lives in memory only: a restart
// starts with nothing floating. The reducers are pure, so they are unit tested; the signals hold the live copy.
//
// This module imports nothing from the panel's own state, so panelState.ts can call into it.
import { signal } from "nsh";
import type { MiniPlayerPosition } from "./miniPlayerLayout";
import type { DeviceTabTarget } from "./panelLogic";

export interface MiniPlayerState {
  /** The floating browser tab's id in its thread's panel (`browser:1`). */
  readonly tabId: string;
  readonly position: MiniPlayerPosition | null;
  readonly width: number | null;
  readonly lastInteraction: "drag" | "resize";
  /** PreviewMiniPlayerSource `{ kind: "device" }`: a device stream floats instead of a browser tab (`tabId` is then the
   * device's tab id, deviceSurfaceId, whether or not the panel has that tab). */
  readonly device?: DeviceTabTarget;
}

/** Keyed by the thread's panel key (panelState.ts `panelKeyFor`). */
export type MiniPlayerStore = Readonly<Record<string, MiniPlayerState>>;

/** `open`: floats `tabId`. Another tab of the same thread takes over the place and size the last one had. */
export function openMini(store: MiniPlayerStore, key: string, tabId: string, device?: DeviceTabTarget): MiniPlayerStore {
  const current = store[key];
  if (current && current.tabId === tabId && (current.device === undefined) === (device === undefined)) return store;
  return { ...store, [key]: { tabId, position: current?.position ?? null, width: current?.width ?? null, lastInteraction: current?.lastInteraction ?? "drag", ...(device ? { device } : {}) } };
}

/** `close` / `removeThread`. */
export function closeMini(store: MiniPlayerStore, key: string): MiniPlayerStore {
  if (!(key in store)) return store;
  const { [key]: _closed, ...rest } = store;
  return rest;
}

/** `move`: `tabId` guards against a drag that outlives the tab it started on. */
export function moveMini(store: MiniPlayerStore, key: string, tabId: string, position: MiniPlayerPosition): MiniPlayerStore {
  const current = store[key];
  if (!current || current.tabId !== tabId) return store;
  if (current.position?.x === position.x && current.position.y === position.y && current.lastInteraction === "drag") return store;
  return { ...store, [key]: { ...current, position, lastInteraction: "drag" } };
}

export function resizeMini(store: MiniPlayerStore, key: string, tabId: string, width: number, position?: MiniPlayerPosition): MiniPlayerStore {
  const current = store[key];
  if (
    !current || current.tabId !== tabId ||
    (current.width === width && current.lastInteraction === "resize" && (!position || (current.position?.x === position.x && current.position.y === position.y)))
  ) return store;
  return { ...store, [key]: { ...current, width, position: position ?? current.position, lastInteraction: "resize" } };
}

/** followPreviewSessions: a floating tab that no longer exists stops floating. */
export function pruneMini(store: MiniPlayerStore, key: string, tabIds: readonly string[]): MiniPlayerStore {
  const current = store[key];
  // A floating device is not a tab: its session ending closes it (agentOpenedDevices.ts), not the tab list.
  return current && current.device === undefined && !tabIds.includes(current.tabId) ? closeMini(store, key) : store;
}

/**
 * shouldRenderPreviewMiniPlayer: the floating tab shows unless the panel is showing that very tab.
 * `renderedActiveId` is the id of the tab in front of an open panel, null while the panel is closed.
 */
export function shouldRenderMiniPlayer(tabId: string | null, renderedActiveId: string | null): boolean {
  return tabId !== null && tabId !== renderedActiveId;
}

const store = signal<MiniPlayerStore>({});

export function miniPlayerFor(key: string | null): MiniPlayerState | null {
  return (key ? store()[key] : undefined) ?? null;
}

export const openMiniPlayer = (key: string, tabId: string) => store.update((all) => openMini(all, key, tabId));
/** previewMiniPlayerStore open(threadRef, { kind: "device", ...target }). */
export const openDeviceMiniPlayer = (key: string, tabId: string, device: DeviceTabTarget) => store.update((all) => openMini(all, key, tabId, device));
/** Every floating entry, by panel key (the device snapshot closes the ones whose session ended). */
export const allMiniPlayers = () => store();
export const closeMiniPlayer = (key: string) => store.update((all) => closeMini(all, key));
export const moveMiniPlayer = (key: string, tabId: string, position: MiniPlayerPosition) => store.update((all) => moveMini(all, key, tabId, position));
export const resizeMiniPlayer = (key: string, tabId: string, width: number, position?: MiniPlayerPosition) => store.update((all) => resizeMini(all, key, tabId, width, position));
export const pruneMiniPlayer = (key: string, tabIds: readonly string[]) => store.update((all) => pruneMini(all, key, tabIds));

/** Tests start from nothing floating. */
export function resetMiniPlayers() {
  store.set({});
}

/**
 * The chat canvas the card is laid out on (the reference's ChatCanvas element: the chat column under the thread header):
 * its top inside the thread row, its size, and the composer lane's height. ThreadView reports it.
 */
export const chatCanvas = signal<{ top: number; width: number; height: number }>({ top: 0, width: 0, height: 0 });

export function reportChatCanvas(bounds: { origin: { y: number }; size: { width: number; height: number } }) {
  const current = chatCanvas();
  if (current.top === bounds.origin.y && current.width === bounds.size.width && current.height === bounds.size.height) return;
  chatCanvas.set({ top: bounds.origin.y, width: bounds.size.width, height: bounds.size.height });
}

/**
 * `--chat-lane-inset-end` (ChatCanvas.tsx): the room the chat lane leaves at the end of the canvas while the card floats
 * beside it. The chat column pads its end by this, so the lane stays centred in what is left. RightPanel.tsx sets it.
 */
export const chatLaneInsetEnd = signal(0);

/**
 * ChatView.tsx `composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}`: on the empty-thread hero the
 * composer sits in the middle of the canvas, not at its bottom, so the floating card treats it as no obstacle (height 0).
 * ThreadView sets it.
 */
export const chatHeroLayout = signal(false);
