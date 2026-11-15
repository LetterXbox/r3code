// Multi-select of thread rows, from threadSelectionStore.ts: modifier-click toggles a row, shift-click
// extends from the anchor, and any plain click or navigation clears. Rows read `isThreadSelected`
// for the selected surface; the bulk menu reads `selectedThreadIds`.
import { signal } from "nsh";

const selected = signal<readonly string[]>([]);
const anchor = signal<string | null>(null);

export const selectedThreadIds = (): readonly string[] => selected();
export const isThreadSelected = (id: string): boolean => selected().includes(id);
export const hasThreadSelection = (): boolean => selected().length > 0;
export const selectionAnchor = (): string | null => anchor();

export function toggleThreadSelection(id: string) {
  const current = selected();
  if (current.includes(id)) {
    selected.set(current.filter((item) => item !== id));
  } else {
    selected.set([...current, id]);
    anchor.set(id);
  }
}

/** Selects everything between the anchor and `id` in `ordered`, keeping what was selected. */
export function rangeSelectTo(id: string, ordered: readonly string[]) {
  const from = anchor();
  const fromIndex = from === null ? -1 : ordered.indexOf(from);
  const toIndex = ordered.indexOf(id);
  if (fromIndex === -1 || toIndex === -1) {
    if (!selected().includes(id)) selected.set([...selected(), id]);
    anchor.set(id);
    return;
  }
  const next = [...selected()];
  for (const key of ordered.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1)) {
    if (!next.includes(key)) next.push(key);
  }
  selected.set(next);
}

export function clearThreadSelection() {
  if (selected().length > 0) selected.set([]);
  if (anchor() !== null) anchor.set(null);
}

export function setSelectionAnchor(id: string) {
  if (anchor() !== id) anchor.set(id);
}

export function removeFromSelection(ids: readonly string[]) {
  const current = selected();
  const next = current.filter((item) => !ids.includes(item));
  if (next.length !== current.length) selected.set(next);
  if (anchor() !== null && ids.includes(anchor()!)) anchor.set(null);
}
