// Port of apps/web/src/components/sidebar/routeReveal.ts. Each change of the open thread, and
// each sidebar mount, scrolls the open thread's row into view once (skipped when the row is under
// the pointer, since it was just clicked). A route change also widens the project scope when the
// open thread is outside it; that waits while the sidebar is searching.
import type { ScrollRef, ViewRef } from "nsh";

export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
}

export function pendingSidebarRouteReveal(reveal: SidebarRouteReveal, routeKey: string | null): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
  }
  return reveal.pendingKey;
}

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

/** resolveSidebarRouteReveal's widening rule: the scope hides the open thread, and no search replaces the list. */
export function routeRevealWidensScope(input: {
  readonly pendingKey: string | null;
  readonly isSearching: boolean;
  readonly scopeIds: readonly string[];
  readonly threadProjectId: string | null | undefined;
  /** filterSidebarV2VisibleThreads with no scope: false for a thread shown under its parent (a delegated child). */
  readonly listedWithoutScope?: boolean;
}): boolean {
  if (input.pendingKey === null || input.isSearching) return false;
  if (input.listedWithoutScope === false) return false;
  if (input.scopeIds.length === 0 || input.threadProjectId == null) return false;
  return !input.scopeIds.includes(input.threadProjectId);
}

/** scrollIntoView({ block: "nearest" }): the offset that brings [top, top + height) into the viewport, or null when it is in view. */
export function nearestScrollOffset(input: { offset: number; viewport: number; rowTop: number; rowHeight: number }): number | null {
  const { offset, viewport, rowTop, rowHeight } = input;
  if (rowTop < 0) return Math.max(0, offset + rowTop);
  const overflow = rowTop + rowHeight - viewport;
  if (overflow > 0) return offset + Math.min(overflow, Math.max(0, rowTop));
  return null;
}

// One sidebar at a time: the route state survives remounts (AppSidebarLayout owns it in the
// reference); the mount reveal is owed again on each mount.
export const sidebarRouteReveal: SidebarRouteReveal = { observedKey: null, pendingKey: null };
let mountRevealOwed = true;
let scrollRef: ScrollRef | null = null;
let scrollOffset = 0;

export function beginSidebarMount(): void {
  mountRevealOwed = true;
  scrollOffset = 0;
}

export function attachSidebarScroll(ref: ScrollRef | null): void {
  scrollRef = ref;
}

export function noteSidebarScroll(offsetY: number): void {
  scrollOffset = offsetY;
}

/** useActiveRowReveal's ref callback: the open row scrolls itself into view when a reveal is owed. */
export function revealActiveRow(row: ViewRef | null, rowKey: string, hovered: boolean): void {
  if (row === null) return;
  if (sidebarRouteReveal.pendingKey !== rowKey && !mountRevealOwed) return;
  completeSidebarRouteReveal(sidebarRouteReveal);
  mountRevealOwed = false;
  if (hovered) return;
  const scroll = scrollRef;
  if (scroll === null) return;
  void Promise.all([row.measure(), scroll.measure()]).then(([rowBox, scrollBox]) => {
    if (!rowBox || !scrollBox) return;
    const next = nearestScrollOffset({
      offset: scrollOffset,
      viewport: scrollBox.bounds.size.height,
      rowTop: rowBox.pagePosition.y - scrollBox.pagePosition.y,
      rowHeight: rowBox.bounds.size.height,
    });
    if (next !== null) scroll.scrollTo({ y: next, animated: false });
  }).catch(() => undefined);
}
