// Desktop back/forward over what the app has shown: threads and the app-modal pages. The web
// leans on the browser's history (navigation.back / navigation.forward, mod+[ and mod+]);
// there is no router here, so this keeps its own stack of places and walks it.
import { batch, effect, signal, untracked } from "nsh";
import {
  closeSettings,
  closeUsage,
  closeUtility,
  openSettings,
  openThread,
  openThreadById,
  openUsage,
  openUtility,
  settingsOpen,
  settingsSection,
  threadById,
  usageOpen,
  utilityPage,
} from "../../store";
import { registerCommands } from "../../commands/registry";

export interface Place {
  thread: string | null;
  /** "settings" carries its section path: `settings:/settings/general`. */
  page: string | null;
}

export const samePlace = (a: Place, b: Place) => a.thread === b.thread && a.page === b.page;

export interface History {
  places: Place[];
  index: number;
}

/** A new place after the current one drops whatever was ahead of it. Repeats of the current place are ignored. */
export function pushPlace(history: History, place: Place): History {
  const current = history.places[history.index];
  if (current && samePlace(current, place)) return history;
  const places = [...history.places.slice(0, history.index + 1), place];
  return { places, index: places.length - 1 };
}

/** The index `step` places away, skipping places `valid` refuses; null when there is none. */
export function stepIndex(history: History, direction: 1 | -1, valid: (place: Place) => boolean = () => true): number | null {
  for (let index = history.index + direction; index >= 0 && index < history.places.length; index += direction) {
    const place = history.places[index];
    if (place && valid(place)) return index;
  }
  return null;
}

const history = signal<History>({ places: [], index: -1 });

function placeNow(): Place {
  const page = settingsOpen() ? `settings:${settingsSection()}` : usageOpen() ? "usage" : utilityPage();
  return { thread: openThread()?.id ?? null, page };
}

const exists = (place: Place) => place.thread === null || threadById(place.thread) !== undefined;

export const canNavigateHistory = (direction: "back" | "forward") =>
  stepIndex(history(), direction === "back" ? -1 : 1, exists) !== null;

function show(place: Place) {
  if (place.thread !== null && openThread()?.id !== place.thread) openThreadById(place.thread);
  const page = place.page;
  if (page === null) {
    if (settingsOpen()) closeSettings();
    if (usageOpen()) closeUsage();
    if (utilityPage() !== null) closeUtility();
  } else if (page.startsWith("settings:")) {
    openSettings(page.slice("settings:".length));
  } else if (page === "usage") {
    openUsage();
  } else if (page === "pull-requests") {
    openUtility("pull-requests");
  } else if (page === "issues") {
    openUtility("issues");
  }
}

/** Walks one place back or forward, as the browser's history does. */
export function navigateHistory(direction: "back" | "forward"): boolean {
  const current = history();
  const index = stepIndex(current, direction === "back" ? -1 : 1, exists);
  if (index === null) return false;
  const place = current.places[index]!;
  // Move first: showing the place changes the store, and the recorder must find it already current.
  batch(() => {
    history.set({ places: current.places, index });
    show(place);
  });
  return true;
}

let started = false;

/** Starts recording (once). Call from the sidebar, which owns the back and forward buttons. */
export function startNavigationHistory() {
  if (started) return;
  started = true;
  effect(() => {
    const place = placeNow();
    const current = untracked(history);
    const next = pushPlace(current, place);
    if (next !== current) history.set(next);
  });
  registerCommands({
    "navigation.back": () => navigateHistory("back"),
    "navigation.forward": () => navigateHistory("forward"),
  });
}
