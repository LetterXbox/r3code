// Message hygiene between a terminal pane and its renderer page / the server. Every message the renderer
// receives can repaint it (a font or theme message rebuilds its atlas, a reset blanks the canvas) and every
// resize reaches the PTY, so a value that did not change must never be sent again. Pure, so it is unit tested.

/** Sends a payload only when it differs from the last one sent under the same kind. */
export function createPostOnce(post: (payload: string) => void) {
  const last: Record<string, string> = {};
  return {
    send(kind: string, payload: string, force = false): boolean {
      if (!force && last[kind] === payload) return false;
      last[kind] = payload;
      post(payload);
      return true;
    },
    /** A freshly loaded page has none of the earlier values: forget them so the next send goes out. */
    forget(kind?: string) {
      if (kind) delete last[kind]; else for (const key of Object.keys(last)) delete last[key];
    },
  };
}

export type Grid = { cols: number; rows: number };

/** A renderer-reported grid, clamped to what the server accepts; null when it is not two finite numbers. */
export function clampGrid(cols: unknown, rows: unknown): Grid | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return { cols: Math.max(1, Math.min(1000, Math.floor(cols))), rows: Math.max(1, Math.min(500, Math.floor(rows))) };
}

export type Scheduler = (run: () => void, delayMs: number) => () => void;
const timeoutScheduler: Scheduler = (run, delayMs) => { const timer = setTimeout(run, delayMs); return () => clearTimeout(timer); };

/**
 * Debounces resize reports and sends one only when the grid really differs from the last one sent.
 * `forget()` (a new attach: the server session may be new) lets the next request through once.
 */
export function createResizeGate(send: (grid: Grid) => void, delayMs = 100, schedule: Scheduler = timeoutScheduler) {
  let sent: Grid | null = null;
  let cancelPending: (() => void) | null = null;
  let latest: Grid | null = null;
  const same = (a: Grid | null, b: Grid | null) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;
  return {
    request(grid: Grid | null) {
      if (!grid) return;
      latest = grid;
      cancelPending?.();
      cancelPending = null;
      if (same(sent, grid)) return;
      cancelPending = schedule(() => {
        cancelPending = null;
        if (!latest || same(sent, latest)) return;
        sent = latest;
        send(latest);
      }, delayMs);
    },
    forget() { sent = null; },
    cancel() { cancelPending?.(); cancelPending = null; },
  };
}

/**
 * Decides whether a snapshot event needs a `reset`: the same history as the last painted one, with no output or
 * clear since, is already on screen, and repainting it would blank and redraw the canvas for nothing.
 */
export function createSnapshotGate() {
  let painted: string | null = null;
  return {
    accept(history: string): boolean {
      if (painted === history) return false;
      painted = history;
      return true;
    },
    /** Output, a clear or a new page changed what is on screen. */
    invalidate() { painted = null; },
  };
}

/** What the history snapshot plus the output since put on the canvas, so a page that loads again repaints it 1:1. */
export function createScreenBuffer(limit = 8 * 1024 * 1024) {
  let text = "";
  return {
    note(message: { type: "reset" | "output"; data: string }) {
      text = message.type === "reset" ? message.data : text + message.data;
      // Beyond the limit the oldest part goes, at a line start so no escape sequence is cut in half where possible.
      if (text.length > limit) {
        const cut = text.indexOf("\n", text.length - limit);
        text = text.slice(cut < 0 ? text.length - limit : cut + 1);
      }
    },
    text: () => text,
    clear() { text = ""; },
  };
}
