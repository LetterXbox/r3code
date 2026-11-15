// ThreadNotificationCoordinator.tsx's desktop notifications on host patch 0010: a native notification per thread (tag
// = the thread), the Dock badge counting the ones not yet seen (cleared when the window comes to the front, as
// notificationBadge.ts does on browser-window-focus), and a click that reveals the window and opens the thread. On a
// host without the patch `notify` resolves false and the caller falls back to osascript (no click, no badge).
import { effect, lifecycle } from "nsh";
import { onDesktopHostEvent, postNativeNotification, revealWindow, setDockBadge } from "./desktopHost";

export interface NativeNotificationDeps {
  post: typeof postNativeNotification;
  badge: (count: number) => unknown;
  open: (threadId: string) => void;
  reveal: () => void;
}

export function createNativeNotifications(deps: NativeNotificationDeps) {
  // tag (threadId) -> notification id
  const pending = new Map<string, string>();
  let counter = 0;
  return {
    async notify(threadId: string, title: string, body: string): Promise<boolean> {
      const id = `thread-notification:${threadId}:${++counter}`;
      const shown = await deps.post({ id, title, body });
      if (!shown) return false;
      pending.set(threadId, id);
      deps.badge(pending.size);
      return true;
    },
    clicked(id: string) {
      for (const [threadId, pendingId] of pending) {
        if (pendingId !== id) continue;
        pending.delete(threadId);
        deps.badge(pending.size);
        deps.reveal();
        deps.open(threadId);
        return true;
      }
      const match = /^thread-notification:(.+):\d+$/.exec(id);
      if (!match?.[1]) return false;
      deps.reveal();
      deps.open(match[1]);
      return true;
    },
    clear() {
      if (pending.size === 0) return;
      pending.clear();
      deps.badge(0);
    },
    pendingCount: () => pending.size,
  };
}

let instance: ReturnType<typeof createNativeNotifications> | null = null;

export function nativeNotifications(open: (threadId: string) => void) {
  if (instance) return instance;
  const created = createNativeNotifications({ post: postNativeNotification, badge: (count) => setDockBadge(count), open, reveal: () => { revealWindow(); } });
  instance = created;
  onDesktopHostEvent<{ id?: unknown }>("notifications.clicked", (data) => { if (typeof data?.id === "string") created.clicked(data.id); });
  effect(() => { if (lifecycle() === "active") created.clear(); });
  return created;
}
