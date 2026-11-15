// ThreadNotificationCoordinator.tsx and BackgroundThreadAnnouncer.tsx: thread status transitions become in-app toasts (when
// `inAppNotificationsEnabled` is on, the window is in front and the thread is not the open one), macOS notifications (when the mode
// asks for them and the window is not in front), the notification sound, and VoiceOver announcements for threads other than the open
// one. Focus is `lifecycle()`; the notification and the Dock badge go through host patch 0010 (desktop/nativeNotifications.ts),
// with osascript as the fallback, and the sound through `process.run` (systemNotify.ts).
import { announce, effect, lifecycle, untracked } from "nsh";
import { playNotificationSound, showSystemNotification } from "./systemNotify";
import { nativeNotifications } from "../../desktop/nativeNotifications";
import { allThreads, backendStatus, openThread, openThreadById, settingValue, shellSnapshotLoaded } from "../../store";
import { closeToast, showToast } from "../toast/toastState";
import {
  backgroundSnapshotOf,
  createThreadNotificationGate,
  nextBackgroundThreadAnnouncement,
  notificationToastView,
  hasNotificationSound,
  notificationsEnabled,
  shouldNotifyDesktop,
  type NotificationMode,
  observeThread,
  readNotificationMode,
  shouldToast,
  type BackgroundThreadMemory,
  type ThreadNotificationKind,
  type ThreadObservation,
} from "./threadNotifications.logic";
import type { Thread } from "../../store";

interface Seen extends ThreadObservation { thread: Thread }

export function createThreadNotificationCoordinator(deps: {
  show: (input: Parameters<typeof showToast>[0]) => string;
  close: (id: string) => void;
  open: (threadId: string) => void;
  isOpenThread: (threadId: string) => boolean;
  inApp: () => boolean;
  /** The window is in front (`lifecycle() === "active"`); default true. */
  focused?: () => boolean;
  mode?: () => NotificationMode;
  notify?: (title: string, body: string, threadId: string) => void;
  sound?: (kind: ThreadNotificationKind) => void;
}) {
  let previous = new Map<string, Seen>();
  const openToasts = new Map<string, string[]>();
  const gate = createThreadNotificationGate<string>((threadId, kind: ThreadNotificationKind) => {
    const seen = previous.get(threadId);
    if (!seen) return;
    const mode = deps.mode?.() ?? "off";
    const focused = deps.focused?.() ?? true;
    const view = notificationToastView(kind, seen.status);
    if (hasNotificationSound(mode)) deps.sound?.(kind);
    if (!shouldToast({ inApp: deps.inApp(), openThreadId: deps.isOpenThread(threadId) ? threadId : null, threadId, focused })) {
      if (shouldNotifyDesktop({ mode, focused })) deps.notify?.(view.title, seen.thread.title, threadId);
      return;
    }
    const id = `thread-notification:${threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    deps.show({
      id,
      type: view.type,
      title: view.title,
      description: seen.thread.title,
      hideCopyButton: true,
      leadingIcon: view.leadingIcon,
      onClose: () => forget(threadId, id),
      // ThreadNotificationCoordinator uses toastManager.add with actionProps: the inline layout.
      actionLayout: "inline",
      actions: [{ label: "Open thread", run: () => { deps.close(id); forget(threadId, id); deps.open(threadId); } }],
    });
    openToasts.set(threadId, [...(openToasts.get(threadId) ?? []), id]);
  });
  const forget = (threadId: string, id: string) => {
    const remaining = (openToasts.get(threadId) ?? []).filter((item) => item !== id);
    if (remaining.length === 0) openToasts.delete(threadId); else openToasts.set(threadId, remaining);
  };
  return {
    /** Feeds one shell snapshot of the live environment's threads. */
    observe(threads: readonly Thread[]) {
      const next = new Map<string, Seen>();
      const changed: Array<[Seen | undefined, Seen]> = [];
      for (const thread of threads) {
        // Subagents and side chats show under their parent; their requests surface there.
        if (thread.relations?.parentThreadId) continue;
        const prior = previous.get(thread.id);
        const seen: Seen = { ...observeThread(thread), thread };
        next.set(thread.id, seen);
        changed.push([prior, seen]);
      }
      previous = next;
      gate.retain(new Set(next.keys()));
      for (const [prior, seen] of changed) gate.observe(seen.thread.id, prior, seen, { archived: false, quiet: false });
    },
    clear() { gate.clear(); previous = new Map(); },
  };
}

let installed = false;

export function installThreadNotifications() {
  if (installed) return;
  installed = true;
  const coordinator = createThreadNotificationCoordinator({
    show: showToast,
    close: closeToast,
    open: openThreadById,
    isOpenThread: (id) => openThread()?.id === id,
    inApp: () => settingValue("inAppNotificationsEnabled") === true,
    focused: () => lifecycle() === "active",
    mode: () => readNotificationMode(settingValue("notificationMode")),
    // Host patch 0010: a native notification whose click opens the thread, and the Dock badge; osascript otherwise.
    notify: (title, body, threadId) => {
      void nativeNotifications(openThreadById).notify(threadId, title, body).then((shown) => { if (!shown) void showSystemNotification(title, body); });
    },
    sound: (kind) => { void playNotificationSound(kind); },
  });
  effect(() => {
    const mode = readNotificationMode(settingValue("notificationMode"));
    const inApp = settingValue("inAppNotificationsEnabled") === true;
    const live = backendStatus() === "connected" && shellSnapshotLoaded();
    const threads = allThreads();
    untracked(() => {
      if (!notificationsEnabled(mode, inApp)) { coordinator.clear(); return; }
      if (live) coordinator.observe(threads);
    });
  });

  // BackgroundThreadAnnouncer: speaks status changes for threads other than the open one.
  let memory: BackgroundThreadMemory = new Map();
  effect(() => {
    const live = backendStatus() === "connected" && shellSnapshotLoaded();
    const threads = allThreads();
    const openId = openThread()?.id ?? null;
    untracked(() => {
      if (!live) return;
      const now = Date.now();
      const next = nextBackgroundThreadAnnouncement(memory, threads.filter((thread) => !thread.relations?.parentThreadId).map((thread) => backgroundSnapshotOf(thread, now)), openId);
      memory = next.memory;
      if (next.announcement !== null) announce(next.announcement);
    });
  });
}
