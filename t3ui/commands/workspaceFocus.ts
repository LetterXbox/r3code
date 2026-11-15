// workspace.focusNext / workspace.focusPrevious (F6, Shift+F6): move the keyboard focus
// between the workspace areas, in the order the web's moveWorkspaceFocus uses
// (sidebar, thread, right panel, terminal). An area registers the function that
// focuses it; areas that are not showing are skipped.
import { registerCommands } from "./registry";

export interface FocusArea { id: string; focus: () => boolean | void; available?: () => boolean }

const ORDER = ["sidebar", "thread", "rightPanel", "terminal"];
const areas = new Map<string, FocusArea>();
let current: string | null = null;

/** Registers how to focus an area. Returns the function that withdraws it. */
export function registerFocusArea(area: FocusArea): () => void {
  areas.set(area.id, area);
  ensureFocusCommands();
  return () => { if (areas.get(area.id) === area) areas.delete(area.id); };
}

/** The area after (or before) `from`, among those registered and available; null when there is none. */
export function nextFocusArea(from: string | null, direction: 1 | -1): string | null {
  const open = ORDER.filter((id) => areas.has(id) && (areas.get(id)!.available?.() ?? true));
  if (open.length === 0) return null;
  const index = from === null ? -1 : open.indexOf(from);
  if (index === -1) return direction === 1 ? open[0]! : open[open.length - 1]!;
  return open[(index + direction + open.length) % open.length]!;
}

export function moveWorkspaceFocus(direction: 1 | -1): boolean {
  const target = nextFocusArea(current, direction);
  if (target === null) return false;
  current = target;
  areas.get(target)!.focus();
  return true;
}

export function registerWorkspaceFocusCommands() {
  registerCommands({
    "workspace.focusNext": () => moveWorkspaceFocus(1),
    "workspace.focusPrevious": () => moveWorkspaceFocus(-1),
  });
}

// F6 is bound only once an area exists, so a bound key never swallows F6 for nothing.
let commandsRegistered = false;
function ensureFocusCommands() {
  if (commandsRegistered) return;
  commandsRegistered = true;
  // Outside the calling component's owner, so the commands outlive it.
  queueMicrotask(registerWorkspaceFocusCommands);
}

/** Tracks where the focus is, so the next F6 continues from there: an area calls this when it takes the focus by itself. */
export function noteFocusArea(id: string) {
  current = id;
}

/** requestWorkspaceFocus (lib/workspaceFocus.ts): focuses one area when it is registered and showing. */
export function requestWorkspaceFocus(id: string): boolean {
  const area = areas.get(id);
  if (!area || area.available?.() === false) return false;
  current = id;
  area.focus();
  return true;
}

/** The area the keyboard was last moved to (F6, requestWorkspaceFocus, or noteFocusArea). */
export const currentWorkspaceFocusArea = () => current;

/**
 * A focus target made of several controls (the details card's rows): the first one still in the tree takes the focus.
 * `track` is the `ref` callback; refs are kept in the order the controls were first drawn.
 */
export function createFocusTargets() {
  const refs: { focus(): void; measure(): Promise<unknown | null> }[] = [];
  return {
    track: (ref: { focus(): void; measure(): Promise<unknown | null> } | null) => { if (ref && !refs.includes(ref)) refs.push(ref); },
    async focusFirst(): Promise<boolean> {
      for (const ref of refs) { if ((await ref.measure()) !== null) { ref.focus(); return true; } }
      return false;
    },
  };
}
