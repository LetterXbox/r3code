// What the server says about a terminal session besides its output: the tab title (the shell's own title, `label`), whether a
// subprocess is running in it (`hasRunningSubprocess`), and the PTY grid every renderer should draw. They arrive on the
// `terminal.attach` stream (the snapshot, and `activity` events) and the web reads them from its terminal session state
// (resolveTerminalSessionLabel, selectRunningSubprocessTerminalIds, setSharedGrid).
import { signal } from "nsh";

export interface TerminalSessionInfo { label: string; running: boolean; cols: number | null; rows: number | null }

const sessions = signal<Readonly<Record<string, TerminalSessionInfo>>>({});
const keyOf = (threadId: string, terminalId: string) => `${threadId}\n${terminalId}`;

/** getTerminalLabel: `term-3` (or `term-3-<uuid>`) reads "Terminal 3"; any other id is its own label. */
export function getTerminalLabel(terminalId: string): string {
  const number = /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(terminalId)?.[1];
  return number ? `Terminal ${number}` : terminalId;
}

/** resolveTerminalSessionLabel: the server's label when it has a non-blank one, else the id's own. */
export function resolveTerminalSessionLabel(terminalId: string, label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : getTerminalLabel(terminalId);
}

const gridSide = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null);

/** Records what a snapshot or an `activity` event carries; fields it omits keep their last value. */
export function noteTerminalSession(threadId: string, terminalId: string, event: { label?: unknown; hasRunningSubprocess?: unknown; cols?: unknown; rows?: unknown }) {
  const key = keyOf(threadId, terminalId);
  const previous = sessions()[key];
  const label = typeof event.label === "string" ? event.label : previous?.label ?? "";
  const running = typeof event.hasRunningSubprocess === "boolean" ? event.hasRunningSubprocess : previous?.running ?? false;
  const cols = gridSide(event.cols) ?? previous?.cols ?? null;
  const rows = gridSide(event.rows) ?? previous?.rows ?? null;
  if (previous && previous.label === label && previous.running === running && previous.cols === cols && previous.rows === rows) return;
  sessions.update((all) => ({ ...all, [key]: { label, running, cols, rows } }));
}

export function forgetTerminalSession(threadId: string, terminalId: string) {
  const key = keyOf(threadId, terminalId);
  if (!(key in sessions())) return;
  sessions.update((all) => { const { [key]: _gone, ...rest } = all; return rest; });
}

/** The title a terminal's tab shows. */
export function terminalSessionLabel(threadId: string, terminalId: string): string {
  return resolveTerminalSessionLabel(terminalId, sessions()[keyOf(threadId, terminalId)]?.label);
}

/** selectRunningSubprocessTerminalIds: the terminals of the thread with a subprocess running. */
export function runningTerminalIds(threadId: string): string[] {
  const prefix = `${threadId}\n`;
  return Object.entries(sessions()).filter(([key, info]) => key.startsWith(prefix) && info.running).map(([key]) => key.slice(prefix.length));
}

/** The PTY grid the server reported for a terminal, or null (an older server, or none yet). */
export function terminalSessionGrid(threadId: string, terminalId: string): { cols: number; rows: number } | null {
  const info = sessions()[keyOf(threadId, terminalId)];
  return info && info.cols !== null && info.rows !== null ? { cols: info.cols, rows: info.rows } : null;
}

/**
 * shouldHandleTerminalExit / synchronizeTerminalStatus: a session that ends is noticed once. The first status of an attach is
 * compared with "closed", so a session that had already exited when it was attached is noticed too; a status "running" (a restart)
 * arms the next end.
 */
export function createExitWatcher(onEnded: (status: "closed" | "exited") => void) {
  let synced = "closed";
  let handled = false;
  return {
    sync(status: string) {
      if (status === "running") handled = false;
      else if ((status === "closed" || status === "exited") && status !== synced && !handled) {
        handled = true;
        onEnded(status);
      }
      synced = status;
    },
    /** The end was noticed and not yet withdrawn (a restart in between withdraws it). */
    get ended() { return handled; },
  };
}

/** Whether the server has reported a session for the terminal (it is attached, so input can be written to it). */
export function hasTerminalSession(threadId: string, terminalId: string): boolean {
  return keyOf(threadId, terminalId) in sessions();
}
