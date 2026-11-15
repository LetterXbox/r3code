// Port of apps/web/src/components/permissions/usePermissionStatus.ts: holds the last permission check and polls while
// started: at once, every 1500 ms, and when the window regains focus. Checks never overlap; a failed check keeps the
// last status and shows the reference's message.
import { signal } from "nsh";

export const PERMISSION_POLL_INTERVAL_MS = 1500;
export const PERMISSION_CHECK_FAILED_MESSAGE = "Could not check permissions. We'll try again automatically.";

export function createPermissionPoller<Id extends string>(check: () => Promise<Record<Id, boolean>>, initialStatus: Record<Id, boolean>, options: { visible?: () => boolean } = {}) {
  const snapshot = signal<{ status: Record<Id, boolean>; error: string | null }>({ status: initialStatus, error: null });
  let checking = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = true;
  const refresh = async () => {
    if (disposed || checking || options.visible?.() === false) return;
    checking = true;
    try {
      const status = await check();
      if (!disposed) snapshot.set({ status, error: null });
    } catch {
      if (!disposed) snapshot.set({ status: snapshot().status, error: PERMISSION_CHECK_FAILED_MESSAGE });
    }
    checking = false;
  };
  return {
    snapshot: () => snapshot(),
    refresh,
    /** Call when the window regains focus or visibility. */
    regained: () => void refresh(),
    start() {
      if (!disposed) return;
      disposed = false;
      void refresh();
      timer = setInterval(() => void refresh(), PERMISSION_POLL_INTERVAL_MS);
    },
    stop() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
