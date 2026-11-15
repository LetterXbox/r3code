/**
 * pageScrollController.ts (reference): PageUp / PageDown typed in the composer scroll the timeline by one page
 * (container height less a 36 px alignment offset and the bottom scroll padding). The reference first lets the
 * prompt editor scroll its own overflow; the host editor reports no scroll metrics, so the composer always hands the
 * key on, which matches the common case of a prompt shorter than its box. Modified keys and IME composition keep
 * their editor meaning.
 */
export type PageScrollKey = "PageUp" | "PageDown";

export const PAGE_SCROLL_ALIGNMENT_OFFSET_PX = 36;
export const PAGE_SCROLL_BOUNDARY_EPSILON_PX = 1;

export interface PageScrollMetrics { top: number; contentHeight: number; viewportHeight: number }

export function pageScrollDistance(viewportHeight: number, scrollPaddingBottom: number): number {
  return Math.max(0, viewportHeight - PAGE_SCROLL_ALIGNMENT_OFFSET_PX - scrollPaddingBottom);
}

/** The offset one page step lands on, or null at the boundary in that direction. */
export function pageScrollTarget(metrics: PageScrollMetrics, key: PageScrollKey, scrollPaddingBottom = 0): number | null {
  const max = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
  const top = Math.min(max, Math.max(0, metrics.top));
  if (key === "PageUp" ? top <= PAGE_SCROLL_BOUNDARY_EPSILON_PX : top >= max - PAGE_SCROLL_BOUNDARY_EPSILON_PX) return null;
  const step = pageScrollDistance(metrics.viewportHeight, scrollPaddingBottom) * (key === "PageUp" ? -1 : 1);
  return Math.min(max, Math.max(0, top + step));
}

/** getTimelinePageScrollKey: the editor key name the composer hands to the timeline, or null to keep it. */
export function composerPageScrollKey(name: string): PageScrollKey | null {
  return name === "PageUp" || name === "PageDown" ? name : null;
}

let handler: ((key: PageScrollKey) => boolean) | null = null;

/** The visible timeline registers its page scroller; the returned function unregisters it. */
export function registerTimelinePageScroll(next: (key: PageScrollKey) => boolean): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

/** Scroll the visible timeline by a page; false when no timeline is shown or it is already at that end. */
export function scrollTimelineByPage(key: PageScrollKey): boolean {
  return handler ? handler(key) : false;
}
