// hooks/useLiveRefresh.ts and hooks/useWorkspaceMutationRefresh.ts. Call both inside a component (they own an effect).
//
// useLiveRefresh: a view that was read before refreshes when the window comes back (lifecycle turns "active") if its
// last read is at least 10 s old, and every `intervalMs` (5 min by default, null for none) while the window is active
// and the user interacted in the last 6 min. Last-read times survive remounts, keyed by `key`.
// The host reports no global pointer/key events, so "interaction" here is the window becoming active or a refresh
// the view asked for (`noteLiveRefreshInteraction`), not every pointer move as on the web.
//
// useWorkspaceMutationRefresh: refetches once per new (resourceKey, mutationId) token.
import { effect, lifecycle, untracked } from "nsh";

export const LIVE_REFRESH_MIN_INTERVAL_MS = 10_000;
export const LIVE_REFRESH_INTERVAL_MS = 5 * 60_000;
export const LIVE_REFRESH_IDLE_AFTER_MS = 6 * 60_000;

const lastRefreshedAtByView = new Map<string, number>();
let lastInteractedAt = Date.now();
let viewCounter = 0;

export function noteLiveRefreshInteraction(now = Date.now()) { lastInteractedAt = now; }

export function shouldRefreshOnArrival(input: { visible: boolean; now: number; lastRefreshedAt: number | undefined }): boolean {
  return input.lastRefreshedAt !== undefined && input.visible && input.now - input.lastRefreshedAt >= LIVE_REFRESH_MIN_INTERVAL_MS;
}

export function shouldRefreshOnInterval(input: { visible: boolean; now: number; lastRefreshedAt: number; lastInteractedAt: number }): boolean {
  return input.now - input.lastInteractedAt < LIVE_REFRESH_IDLE_AFTER_MS && input.visible && input.now - input.lastRefreshedAt >= LIVE_REFRESH_MIN_INTERVAL_MS;
}

export function useLiveRefresh(refresh: (() => void) | null, options: { enabled?: () => boolean; key?: string; intervalMs?: number | null } = {}): void {
  const viewId = options.key ?? `live-refresh:${++viewCounter}`;
  const intervalMs = options.intervalMs === undefined ? LIVE_REFRESH_INTERVAL_MS : options.intervalMs;
  const read = (now: number) => {
    if (refresh === null) return;
    lastRefreshedAtByView.set(viewId, now);
    refresh();
  };
  const onArrival = () => {
    const now = Date.now();
    if (now - lastInteractedAt >= LIVE_REFRESH_IDLE_AFTER_MS) return;
    const lastRefreshedAt = lastRefreshedAtByView.get(viewId);
    if (lastRefreshedAt === undefined) { lastRefreshedAtByView.set(viewId, now); return; }
    if (shouldRefreshOnArrival({ visible: lifecycle() === "active", now, lastRefreshedAt })) read(now);
  };
  effect(() => {
    if (options.enabled && !options.enabled()) return;
    const active = lifecycle() === "active";
    untracked(() => {
      if (active) noteLiveRefreshInteraction();
      onArrival();
    });
    if (!active || intervalMs === null) return;
    const timer = setInterval(() => {
      const now = Date.now();
      const lastRefreshedAt = lastRefreshedAtByView.get(viewId) ?? now;
      if (shouldRefreshOnInterval({ visible: lifecycle() === "active", now, lastRefreshedAt, lastInteractedAt })) read(now);
    }, intervalMs);
    return () => clearInterval(timer);
  });
}

/** workspaceMutationRefreshToken: null without a mutation id. */
export function workspaceMutationRefreshToken(resourceKey: string, mutationId: string | null): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

export function useWorkspaceMutationRefresh(input: { enabled?: () => boolean; mutationId: () => string | null; refresh: () => void; resourceKey: () => string }): void {
  let handled: string | null = null;
  effect(() => {
    if (input.enabled && !input.enabled()) return;
    const token = workspaceMutationRefreshToken(input.resourceKey(), input.mutationId());
    if (token === null || token === handled) return;
    handled = token;
    untracked(input.refresh);
  });
}
