// Terminal drawer state rules (terminalUiStateStore.ts in the web app): terminals
// live in groups; a group is one entry in the sidebar and shows its terminals
// side by side (or stacked) as splits. Pure, so it is tested without an engine.

export type SplitDirection = "horizontal" | "vertical";

export interface TerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection: SplitDirection;
}

export interface TerminalDrawerState {
  groups: TerminalGroup[];
  activeGroupId: string | null;
  activeTerminalId: string | null;
  /** The next number `term-N` ids and `group-N` ids are minted from. */
  counter: number;
  height: number;
}

/** MAX_TERMINALS_PER_GROUP and DEFAULT_THREAD_TERMINAL_HEIGHT in apps/web/src/types.ts. */
export const MAX_TERMINALS_PER_GROUP = 4;
export const DEFAULT_TERMINAL_HEIGHT = 280;
/** MIN_DRAWER_HEIGHT in ThreadTerminalDrawer.tsx. */
export const MIN_TERMINAL_HEIGHT = 180;

/** The first terminal keeps the id earlier builds used, so its session resumes. */
export function initialDrawerState(): TerminalDrawerState {
  return { groups: [{ id: "group-1", terminalIds: ["term-1"], splitDirection: "horizontal" }], activeGroupId: "group-1", activeTerminalId: "term-1", counter: 2, height: DEFAULT_TERMINAL_HEIGHT };
}

export function emptyDrawerState(height = DEFAULT_TERMINAL_HEIGHT): TerminalDrawerState {
  return { groups: [], activeGroupId: null, activeTerminalId: null, counter: 1, height };
}

/** getTerminalLabel(): `term-3` reads "Terminal 3". */
export function terminalLabel(terminalId: string): string {
  const number = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  return number ? `Terminal ${number}` : terminalId;
}

export function allTerminalIds(state: TerminalDrawerState): string[] {
  return state.groups.flatMap((group) => group.terminalIds);
}

export function activeGroup(state: TerminalDrawerState): TerminalGroup | null {
  return state.groups.find((group) => group.id === state.activeGroupId) ?? null;
}

/** Ids taken outside this drawer (useThreadTerminalActions.allocateTerminalId): the server's known sessions and the
 * panel's terminals; `suffix` is the reference's random suffix when this client cannot read the server's sessions. */
export interface TerminalAllocation { used?: readonly string[]; suffix?: string }

/** nextTerminalId's number of an id: `term-3` and `term-3-<suffix>` are both 3. */
function terminalNumberOf(id: string): string | null {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(id)?.[1] ?? null;
}

function mint(state: TerminalDrawerState, allocation: TerminalAllocation = {}): { terminalId: string; groupId: string; counter: number } {
  const numbers = new Set([...allTerminalIds(state), ...(allocation.used ?? [])].map(terminalNumberOf).filter((n): n is string => n !== null));
  let counter = state.counter;
  while (numbers.has(String(counter))) counter++;
  const suffix = allocation.suffix ? `-${allocation.suffix}` : "";
  return { terminalId: `term-${counter}${suffix}`, groupId: `group-${counter}`, counter: counter + 1 };
}

/** The + button: a new terminal in a group of its own, made active. */
export function newTerminal(state: TerminalDrawerState, allocation?: TerminalAllocation): TerminalDrawerState {
  const next = mint(state, allocation);
  return {
    ...state,
    groups: [...state.groups, { id: next.groupId, terminalIds: [next.terminalId], splitDirection: "horizontal" }],
    activeGroupId: next.groupId,
    activeTerminalId: next.terminalId,
    counter: next.counter,
  };
}

export function hasReachedSplitLimit(state: TerminalDrawerState): boolean {
  const group = activeGroup(state);
  return !group || group.terminalIds.length >= MAX_TERMINALS_PER_GROUP;
}

/** Splits the active group: one more terminal beside (horizontal) or below (vertical) the others. */
export function splitTerminal(state: TerminalDrawerState, direction: SplitDirection, allocation?: TerminalAllocation): TerminalDrawerState {
  const group = activeGroup(state);
  if (!group || group.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return state;
  const next = mint(state, allocation);
  return {
    ...state,
    groups: state.groups.map((item) => (item.id === group.id ? { ...item, splitDirection: direction, terminalIds: [...item.terminalIds, next.terminalId] } : item)),
    activeTerminalId: next.terminalId,
    counter: next.counter,
  };
}

export function activateTerminal(state: TerminalDrawerState, terminalId: string): TerminalDrawerState {
  const group = state.groups.find((item) => item.terminalIds.includes(terminalId));
  return group ? { ...state, activeGroupId: group.id, activeTerminalId: terminalId } : state;
}

/** Closing the last terminal leaves an empty drawer with its "No terminal sessions" state. */
export function closeTerminal(state: TerminalDrawerState, terminalId: string): TerminalDrawerState {
  const groupIndex = state.groups.findIndex((group) => group.terminalIds.includes(terminalId));
  if (groupIndex < 0) return state;
  const group = state.groups[groupIndex]!;
  const index = group.terminalIds.indexOf(terminalId);
  const remaining = group.terminalIds.filter((id) => id !== terminalId);
  const groups = remaining.length === 0
    ? state.groups.filter((item) => item.id !== group.id)
    : state.groups.map((item) => (item.id === group.id ? { ...item, terminalIds: remaining } : item));
  if (state.activeTerminalId !== terminalId) return { ...state, groups };
  if (remaining.length > 0) return { ...state, groups, activeGroupId: group.id, activeTerminalId: remaining[Math.min(index, remaining.length - 1)]! };
  const neighbour = groups[Math.min(groupIndex, groups.length - 1)];
  return { ...state, groups, activeGroupId: neighbour?.id ?? null, activeTerminalId: neighbour?.terminalIds[0] ?? null };
}

/** `budget`: the room the chat column leaves after the composer; like the web it caps the drawer even below the minimum. */
export function clampTerminalHeight(height: number, windowHeight: number, budget?: number): number {
  const windowCap = Math.max(MIN_TERMINAL_HEIGHT, Math.floor(windowHeight * 0.75));
  const maxHeight = budget === undefined ? windowCap : Math.min(windowCap, Math.max(0, budget));
  const safe = Number.isFinite(height) ? height : DEFAULT_TERMINAL_HEIGHT;
  return Math.min(Math.max(Math.round(safe), MIN_TERMINAL_HEIGHT), maxHeight);
}

/** The drawer's action labels, with the web's wording. */
export function terminalActionLabels(state: TerminalDrawerState, shortcuts: { split?: string; splitVertical?: string; create?: string; close?: string } = {}) {
  const limit = hasReachedSplitLimit(state);
  const split = (name: string, shortcut: string | undefined) =>
    limit ? `${name} (max ${MAX_TERMINALS_PER_GROUP} per group)` : shortcut ? `${name} (${shortcut})` : name;
  return {
    split: split("Split Terminal Horizontally", shortcuts.split),
    splitVertical: split("Split Terminal Vertically", shortcuts.splitVertical),
    create: shortcuts.create ? `New Terminal (${shortcuts.create})` : "New Terminal",
    close: shortcuts.close ? `Close Terminal (${shortcuts.close})` : "Close Terminal",
  };
}

export function readDrawerState(value: unknown): TerminalDrawerState {
  if (typeof value !== "object" || value === null) return initialDrawerState();
  const raw = value as Record<string, unknown>;
  const groups: TerminalGroup[] = [];
  if (Array.isArray(raw.groups)) {
    for (const item of raw.groups) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const ids = Array.isArray(entry.terminalIds) ? entry.terminalIds.filter((id): id is string => typeof id === "string" && /^term-\d+$/.test(id)).slice(0, MAX_TERMINALS_PER_GROUP) : [];
      if (typeof entry.id === "string" && ids.length > 0) groups.push({ id: entry.id, terminalIds: ids, splitDirection: entry.splitDirection === "vertical" ? "vertical" : "horizontal" });
    }
  }
  const height = typeof raw.height === "number" ? clampTerminalHeight(raw.height, 4000) : DEFAULT_TERMINAL_HEIGHT;
  if (groups.length === 0) return raw.groups instanceof Array && raw.groups.length === 0 ? emptyDrawerState(height) : { ...initialDrawerState(), height };
  const ids = groups.flatMap((group) => group.terminalIds);
  const counter = Math.max(...ids.map((id) => Number(id.slice(5)))) + 1;
  const activeTerminalId = typeof raw.activeTerminalId === "string" && ids.includes(raw.activeTerminalId) ? raw.activeTerminalId : ids[0]!;
  const activeGroupId = groups.find((group) => group.terminalIds.includes(activeTerminalId))!.id;
  return { groups, activeGroupId, activeTerminalId, counter, height };
}

export const DEFAULT_TERMINAL_FONT_SIZE = 12;

/**
 * The renderer's font message. ThreadTerminalDrawer.tsx resolves the preference with
 * resolveTerminalFontPreference (the Terminal font row is shown, so the advanced branch)
 * and terminalFontOptions() leaves an empty family out so the renderer keeps its default stack.
 */
export function terminalFontMessage(family: unknown, size: unknown): { type: "font"; family: string; size: number } {
  return {
    type: "font",
    family: typeof family === "string" ? family.trim() : "",
    size: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : DEFAULT_TERMINAL_FONT_SIZE,
  };
}

/**
 * The renderer's font from the app's typography (`terminalTextStyle`): its size always, its family only when the user
 * chose one, so the renderer keeps its own default stack otherwise (`custom` is the quoted list `cssFontFamilies` gives, or null).
 */
export function terminalRendererFont(style: { fontSize: number }, custom: string | null) {
  return terminalFontMessage(custom ?? "", style.fontSize);
}

/** reconcileThreadTerminalSessionIds + PersistentThreadTerminals (terminalUiStateStore.ts:452-476, 686-697): the drawer
 * follows the server's list of this thread's drawer terminals. Ids this client closed (`suppressed`) stay out; a list that
 * is a strict subset of the drawer's (a terminal opened here the server has not reported yet) changes nothing; otherwise
 * terminals the server no longer has leave their groups, ones only the server has get a group each, and the active
 * terminal falls back to the first. */
export function reconcileDrawerTerminals(state: TerminalDrawerState, serverIds: readonly string[], suppressed: ReadonlySet<string> = new Set()): TerminalDrawerState {
  const next = serverIds.filter((id) => !suppressed.has(id));
  const current = allTerminalIds(state);
  if (next.length === current.length && next.every((id, index) => id === current[index])) return state;
  if (next.length < current.length && next.every((id) => current.includes(id))) return state;
  const keep = new Set(next);
  let counter = state.counter;
  const groups = state.groups.map((group) => ({ ...group, terminalIds: group.terminalIds.filter((id) => keep.has(id)) })).filter((group) => group.terminalIds.length > 0);
  for (const id of next) {
    if (groups.some((group) => group.terminalIds.includes(id))) continue;
    let groupId = `group-${counter}`;
    while (groups.some((group) => group.id === groupId)) groupId = `group-${++counter}`;
    counter += 1;
    groups.push({ id: groupId, terminalIds: [id], splitDirection: "horizontal" });
  }
  const activeTerminalId = state.activeTerminalId && keep.has(state.activeTerminalId) ? state.activeTerminalId : (groups[0]?.terminalIds[0] ?? null);
  const activeGroupId = groups.find((group) => activeTerminalId !== null && group.terminalIds.includes(activeTerminalId))?.id ?? groups[0]?.id ?? null;
  return { ...state, groups, activeGroupId, activeTerminalId, counter: Math.max(counter, state.counter) };
}
