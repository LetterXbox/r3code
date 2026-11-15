// Keyboard navigation of the sidebar list, from lib/sidebarTree.ts. Arrow keys move focus
// between rows without opening them (as VS Code's list does): Up and Down step, Home and End
// jump, Right expands a closed folder or enters an open one, Left closes an open folder or
// goes to its parent. Opening stays with Enter and Space, which the rows own.
import { effect, keymap, signal } from "nsh";
import type { ViewRef } from "nsh";

export interface TreeRow {
  id: string;
  /** The folder or shelf row this one sits under. */
  parent: string | null;
  /** Whether it can open: true or false for a folder or shelf header, null for a leaf. */
  expanded: boolean | null;
}

export type TreeKey = "up" | "down" | "left" | "right" | "home" | "end";

export interface TreeMove {
  /** The row to give the keyboard focus. */
  focus?: string;
  /** Open or close the row that has it. */
  toggle?: boolean;
}

export const threadRowId = (id: string) => `thread:${id}`;
export const projectRowId = (id: string) => `project:${id}`;
export const shelfRowId = (shelf: "working" | "snoozed" | "settled") => `shelf:${shelf}`;
export const draftRowId = (id: string) => `draft:${id}`;

/** What a key does on the row `id`; null when it does nothing (or the row is gone). */
export function nextTreeMove(rows: readonly TreeRow[], id: string, key: TreeKey): TreeMove | null {
  const index = rows.findIndex((row) => row.id === id);
  const row = rows[index];
  if (!row) return null;
  switch (key) {
    case "down": return { focus: rows[Math.min(index + 1, rows.length - 1)]?.id };
    case "up": return { focus: rows[Math.max(index - 1, 0)]?.id };
    case "home": return { focus: rows[0]?.id };
    case "end": return { focus: rows[rows.length - 1]?.id };
    case "right": {
      if (row.expanded === false) return { toggle: true };
      const child = rows.find((candidate) => candidate.parent === row.id);
      return child ? { focus: child.id } : null;
    }
    case "left": {
      if (row.expanded === true) return { toggle: true };
      return row.parent !== null && rows.some((candidate) => candidate.id === row.parent) ? { focus: row.parent } : null;
    }
  }
}

const refs = new Map<string, ViewRef>();
const toggles = new Map<string, () => void>();
const focused = signal<string | null>(null);

/** The row that has the keyboard focus, or null when focus is elsewhere. */
export const focusedTreeRow = () => focused();

// The web draws `focus-visible:ring-2 ring-inset ring-ring` on a row: the ring follows the keyboard, never a press.
const keyboardDriven = signal(false);
/** Whether `id` shows the focus ring: it has the focus and the keys put it there. */
export const showsFocusRing = (id: string) => focused() === id && keyboardDriven();
/** A press or a hover hands the pointer the focus: the ring goes. */
export const releaseFocusRing = () => { if (keyboardDriven()) keyboardDriven.set(false); };

/**
 * What a row spreads on its pressable view to take part: its ref (so focus can move to it)
 * and focus tracking. `toggle` is what Left and Right call to close or open a folder.
 */
export function treeRowProps(id: string, toggle?: () => void) {
  return {
    ref: (node: ViewRef | null) => {
      if (node) refs.set(id, node);
      else refs.delete(id);
      if (toggle) toggles.set(id, toggle);
      else toggles.delete(id);
    },
    onFocus: () => focused.set(id),
    // Moving from one row to the next blurs the old one after the new one took focus.
    onBlur: () => { if (focused() === id) focused.set(null); },
  };
}

/** Runs one key on the focused row. True when it was handled. */
export function runTreeKey(key: TreeKey, rows: () => TreeRow[]): boolean {
  const id = focused();
  if (id === null) return false;
  const move = nextTreeMove(rows(), id, key);
  if (!move) return false;
  if (move.toggle) toggles.get(id)?.();
  keyboardDriven.set(true);
  if (move.focus !== undefined && move.focus !== id) refs.get(move.focus)?.focus();
  return true;
}

/** Binds the arrow keys while a row has the focus. Call from a component or effect. */
export function bindTreeKeys(rows: () => TreeRow[]) {
  effect(() => {
    if (focused() === null) return;
    return keymap.bind({
      up: () => { runTreeKey("up", rows); },
      down: () => { runTreeKey("down", rows); },
      left: () => { runTreeKey("left", rows); },
      right: () => { runTreeKey("right", rows); },
      home: () => { runTreeKey("home", rows); },
      end: () => { runTreeKey("end", rows); },
    }, { when: "notEditing", repeat: true });
  });
}
