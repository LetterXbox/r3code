import { signal } from "nsh";

export const PULL_REQUEST_PANEL_WIDTH_KEY = "t3code:pull-request-panel-width";

/** Restore once; a late read must not undo a width the user just dragged to. */
export function createPullRequestPanelWidth(storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> }) {
  const saved = signal<number | null>(null);
  let changed = false;
  void storage.getItem(PULL_REQUEST_PANEL_WIDTH_KEY).then((raw) => {
    if (changed || raw === null) return;
    try { const value: unknown = JSON.parse(raw); if (typeof value === "number" && Number.isFinite(value)) saved.set(value); } catch { /* invalid saved width */ }
  }).catch(() => {});
  return {
    saved,
    commit(width: number) {
      changed = true;
      saved.set(width);
      void storage.setItem(PULL_REQUEST_PANEL_WIDTH_KEY, JSON.stringify(width)).catch(() => {});
    },
  };
}
