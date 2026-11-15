// Which thread drawers stay mounted (PersistentThreadTerminals.tsx keeps a terminal view alive per thread, so
// switching threads and back neither reloads the renderer page nor replays history). Pure, so it is unit tested.

export interface DrawerTarget { key: string; threadId: string; cwd: string }

export const MAX_PERSISTENT_DRAWERS = 6;

/**
 * The mounted drawers after `current` (the open thread's drawer, or null) is shown: it moves to the end (most
 * recent), a target seen before keeps its place in the list's identity, and the oldest hidden ones beyond `cap`
 * are dropped (their server sessions keep running; only the renderer page is released).
 */
export function nextMountedDrawers(mounted: readonly DrawerTarget[], current: DrawerTarget | null, cap = MAX_PERSISTENT_DRAWERS): readonly DrawerTarget[] {
  if (!current) return mounted;
  const existing = mounted.find((target) => target.key === current.key);
  if (existing && existing.threadId === current.threadId && existing.cwd === current.cwd && mounted[mounted.length - 1] === existing) return mounted;
  const rest = mounted.filter((target) => target.key !== current.key);
  const next = [...rest, existing && existing.threadId === current.threadId && existing.cwd === current.cwd ? existing : current];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Whether the drawer for `key` is the one on screen. */
export function drawerShown(key: string, current: DrawerTarget | null, suspended: boolean): boolean {
  return !suspended && current !== null && current.key === key;
}
