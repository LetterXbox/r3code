// Which right-panel tabs keep their page while they are not on screen. A browser tab and a terminal tab are native web
// views: made again, the browser reloads (its scroll position, form input and history are gone) and the terminal
// rebuilds its renderer. The reference keeps one browser session per tab in the desktop's main process, alive until the
// tab closes, whatever the panel does (apps/desktop/src/preview, PreviewView.tsx). Here those tabs stay mounted and are
// only hidden: across a thread switch and back, and while the panel is closed. Pure, so it is unit tested.
import type { Surface, SurfaceTag } from "./panelLogic";

/** One kept tab: the panel (thread) it belongs to, that thread's folder, and the tab. */
export interface KeptSurface { panelKey: string; threadId: string; cwd: string; id: string; kind: SurfaceTag }

/** Threads whose tabs stay mounted. Each kept page is a WKWebView with a web content process, so the oldest go first. */
export const MAX_KEPT_PANELS = 6;

/** The tab kinds whose page is kept: the ones a remount destroys state in. */
export function keepsPage(kind: SurfaceTag): boolean {
  return kind === "preview" || kind === "terminal";
}

/** The Each key of a kept tab: tab ids repeat across threads (browser:1), so the panel is part of it. */
export function keptSurfaceKey(entry: KeptSurface): string {
  return `${entry.panelKey}\n${entry.id}`;
}

export interface KeptPanel { panelKey: string; threadId: string; cwd: string; surfaces: readonly Surface[] }

/**
 * The kept tabs after `current` (the open thread's panel, or null when no panel applies) is shown: its page tabs follow
 * its tab list (a closed tab is dropped, an entry seen before keeps its identity) and go last (most recent); the tabs
 * of other threads stay while `alive` still finds them, and the oldest threads beyond `cap` are dropped.
 * Returns `kept` itself when nothing changed.
 */
export function nextKeptSurfaces(
  kept: readonly KeptSurface[], current: KeptPanel | null, alive: (panelKey: string, id: string) => boolean, cap = MAX_KEPT_PANELS,
): readonly KeptSurface[] {
  let next = kept.filter((entry) => (current !== null && entry.panelKey === current.panelKey ? false : alive(entry.panelKey, entry.id)));
  if (current !== null) {
    for (const surface of current.surfaces) {
      if (!keepsPage(surface.kind)) continue;
      const existing = kept.find((entry) => entry.panelKey === current.panelKey && entry.id === surface.id);
      next.push(existing && existing.threadId === current.threadId && existing.cwd === current.cwd && existing.kind === surface.kind
        ? existing
        : { panelKey: current.panelKey, threadId: current.threadId, cwd: current.cwd, id: surface.id, kind: surface.kind });
    }
  } else if (next.length === kept.length) {
    return kept;
  }
  const panels: string[] = [];
  for (const entry of next) if (!panels.includes(entry.panelKey)) panels.push(entry.panelKey);
  if (panels.length > cap) {
    const dropped = new Set(panels.slice(0, panels.length - cap));
    next = next.filter((entry) => !dropped.has(entry.panelKey));
  }
  return next.length === kept.length && next.every((entry, index) => entry === kept[index]) ? kept : next;
}
