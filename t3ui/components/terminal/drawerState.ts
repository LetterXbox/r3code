// Per-thread terminal drawer state, remembered across restarts. The rules are in
// terminalLogic.ts.
import { signal, Storage } from "nsh";
import { emptyDrawerState, readDrawerState, type TerminalDrawerState } from "./terminalLogic";

const STORAGE_KEY = "terminalDrawers";
const states = signal<Record<string, TerminalDrawerState>>({});
let loaded = false;

function persist() {
  void Storage.setItem(STORAGE_KEY, JSON.stringify(states())).catch(() => {});
}

void Storage.getItem(STORAGE_KEY).then((text) => {
  if (loaded || !text) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return;
    const next: Record<string, TerminalDrawerState> = {};
    for (const [key, value] of Object.entries(parsed)) next[key] = readDrawerState(value);
    states.update((current) => ({ ...next, ...current }));
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => {}).finally(() => { loaded = true; });

export function drawerStateFor(key: string): TerminalDrawerState {
  return states()[key] ?? emptyDrawerState();
}

export function updateDrawer(key: string, change: (state: TerminalDrawerState) => TerminalDrawerState) {
  const before = states()[key] ?? emptyDrawerState();
  const after = change(before);
  // A focus report re-activates the already active terminal: no new state, no write, no re-render of the drawer.
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) { if (!states()[key]) states.update((current) => ({ ...current, [key]: after })); return; }
  states.update((current) => ({ ...current, [key]: after }));
  persist();
}

// suppressedTerminalIdsByThreadKey: terminals closed here stay out of the drawer even while the server still lists them.
const suppressed = new Map<string, Set<string>>();
export function suppressDrawerTerminal(key: string, terminalId: string) { const set = suppressed.get(key) ?? new Set<string>(); set.add(terminalId); suppressed.set(key, set); }
export function unsuppressDrawerTerminal(key: string, terminalId: string) { suppressed.get(key)?.delete(terminalId); }
export const suppressedDrawerTerminals = (key: string): ReadonlySet<string> => suppressed.get(key) ?? new Set<string>();
