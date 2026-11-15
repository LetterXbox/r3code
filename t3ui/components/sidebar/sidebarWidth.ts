// The sidebar's resizable width, from components/threadSidebarWidth.ts and AppSidebarLayout.tsx.
// Default 16rem, at least 13rem, and the main column keeps 40rem. The web keeps the width in
// localStorage ("chat_thread_sidebar_width") and writes it when a drag ends; this does the same
// with nsh Storage.
import { signal, Storage, windowSize } from "nsh";

export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number, minimumWidth = THREAD_SIDEBAR_MIN_WIDTH): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(width: number, minimumWidth: number, maximumWidth: number): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(storedWidth: number | null, viewportWidth: number): number {
  const preferred = storedWidth === null
    ? THREAD_SIDEBAR_DEFAULT_WIDTH
    : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferred, resolveThreadSidebarMaximumWidth(viewportWidth));
}

/** What a drag from `start` gives when the pointer has travelled `travel` points to the right. */
export function draggedSidebarWidth(start: number, travel: number, viewportWidth: number): number {
  return clampThreadSidebarWidth(start + travel, THREAD_SIDEBAR_MIN_WIDTH, resolveThreadSidebarMaximumWidth(viewportWidth));
}

/** The web logs (console.error, no toast) when the saved width cannot be removed: AppSidebarLayout.tsx resetSidebarWidth. */
export const CLEAR_STORED_WIDTH_ERROR = "Could not clear persisted thread sidebar width.";
export const READ_STORED_WIDTH_ERROR = "Could not read persisted thread sidebar width.";

function clearStoredWidth() {
  void Storage.removeItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY).catch((error: unknown) => { console.error(CLEAR_STORED_WIDTH_ERROR, error); });
}

const stored = signal<number | null>(null);
/** The width while a drag is live; it is written to Storage only when the drag ends. */
const live = signal<number | null>(null);

function viewportWidth(): number {
  const width = windowSize().width;
  return width > 0 ? width : 1280;
}

/** The column's width now: the live drag, else the saved width (or the default), kept inside the window. */
export function sidebarWidth(): number {
  const current = live();
  if (current !== null) return current;
  return resolveInitialThreadSidebarWidth(stored(), viewportWidth());
}

export const sidebarWidthDragging = () => live() !== null;

export function setLiveSidebarWidth(width: number | null) {
  live.set(width === null ? null : draggedSidebarWidth(width, 0, viewportWidth()));
}

/** Saves the width and ends the drag. */
export function commitSidebarWidth(width: number) {
  const next = draggedSidebarWidth(width, 0, viewportWidth());
  live.set(null);
  // Dragging back to the default is no override: nothing is kept, so a later change of the default reaches the user.
  if (next === THREAD_SIDEBAR_DEFAULT_WIDTH) {
    stored.set(null);
    clearStoredWidth();
    return;
  }
  stored.set(next);
  void Storage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, String(next)).catch(() => {});
}

/** Double-click on the rail: back to the default width. */
export function resetSidebarWidth() {
  stored.set(null);
  live.set(null);
  clearStoredWidth();
}

let loading: Promise<void> | null = null;
export function loadSidebarWidth(): Promise<void> {
  loading ??= (async () => {
    try {
      const raw = await Storage.getItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
      const parsed = raw === null || raw === undefined ? NaN : Number(raw);
      if (Number.isFinite(parsed)) stored.set(parsed);
    } catch (error) {
      // A damaged value is the same as none, as the web starts from the default width after logging it.
      console.error(READ_STORED_WIDTH_ERROR, error);
    }
  })();
  return loading;
}

void loadSidebarWidth();
