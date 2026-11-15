// ThreadNotificationCoordinator.logic.ts, the presentation inside ThreadNotificationCoordinator.tsx, and
// backgroundThreadAnnouncement.ts / threadActivityAnnouncement.ts: which thread transitions notify, what the toast says, and what
// the screen reader is told about threads that are not open.
import type { Thread } from "../../store";
import { resolveThreadStatus, type SidebarThreadStatus } from "../sidebar/threadStatus";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

export function createThreadNotificationGate<Key>(notify: (key: Key, kind: ThreadNotificationKind) => void) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(key: Key, prior: ThreadNotificationObservation | undefined, next: ThreadNotificationObservation, options: { readonly archived: boolean; readonly quiet: boolean }): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}

const ATTENTION: readonly SidebarThreadStatus[] = ["input", "request", "approval", "failed", "limited"];

export interface ThreadObservation extends ThreadNotificationObservation { status: SidebarThreadStatus }

/** The coordinator's `observeThreads` for one thread of the shell snapshot. */
export function observeThread(thread: Thread): ThreadObservation {
  const meta = thread.meta;
  let status = resolveThreadStatus(thread);
  if (status === "ready" && meta?.runStatus === "failed") status = "failed";
  const attention = ATTENTION.includes(status) ? `${meta?.latestRunId ?? ""}:${status}` : null;
  const completedAt = meta?.latestRunCompletedAt ?? null;
  const settled = status === "ready" && meta?.runStatus === "completed";
  return { status, attention, settled, completedAt: settled && completedAt !== null && Number.isFinite(completedAt) ? completedAt : null };
}

export interface NotificationToastView {
  title: string;
  type: "success" | "error" | "warning";
  leadingIcon: { name: "circle-check" | "circle-alert" | "shield-question" | "message-circle-question"; tone: "success" | "warning" | "destructive" | "info" };
}

/** The toast title, type and mark the web picks by kind and thread status. */
export function notificationToastView(kind: ThreadNotificationKind, status: SidebarThreadStatus): NotificationToastView {
  const title = kind === "completion" ? "Thread completed"
    : status === "approval" ? "Approval needed"
    : status === "limited" ? "Usage limit reached"
    : status === "failed" ? "Thread failed"
    : status === "request" ? "Guest request"
    : "Input needed";
  const type = kind === "completion" ? "success" : status === "failed" ? "error" : "warning";
  const leadingIcon: NotificationToastView["leadingIcon"] = kind === "completion" ? { name: "circle-check", tone: "success" }
    : status === "approval" ? { name: "shield-question", tone: "warning" }
    : status === "limited" ? { name: "circle-alert", tone: "warning" }
    : status === "failed" ? { name: "circle-alert", tone: "destructive" }
    : { name: "message-circle-question", tone: "info" };
  return { title, type, leadingIcon };
}

/** NotificationMode (contracts settings.ts). */
export type NotificationMode = "off" | "notifications" | "sound" | "notifications-and-sound";
export const hasNotificationSound = (mode: NotificationMode) => mode === "sound" || mode === "notifications-and-sound";
export const hasDesktopNotifications = (mode: NotificationMode) => mode === "notifications" || mode === "notifications-and-sound";

export function readNotificationMode(value: unknown): NotificationMode {
  return value === "notifications" || value === "sound" || value === "notifications-and-sound" ? value : "off";
}

/** The coordinator watches only while a mode or the in-app toggle asks for it (syncEnvironments). */
export const notificationsEnabled = (mode: NotificationMode, inApp: boolean) => mode !== "off" || inApp;

/** In-app toasts show for threads other than the open one, while the window is in front. */
export const shouldToast = (input: { inApp: boolean; openThreadId: string | null; threadId: string; focused?: boolean }) => input.inApp && (input.focused ?? true) && input.openThreadId !== input.threadId;

/** A system notification is for a window that is not in front (`lifecycle()` is not "active"). */
export const shouldNotifyDesktop = (input: { mode: NotificationMode; focused: boolean }) => hasDesktopNotifications(input.mode) && !input.focused;

// --- the screen reader (backgroundThreadAnnouncement.ts) ---------------------------------------------------------

export const THREAD_STATUS_TEXT = { approval: "Needs approval", input: "Needs your input", done: "Done", failed: "Failed", stopped: "Stopped" } as const;

export function runOutcomeText(status: string | null | undefined): string | null {
  switch (status) {
    case "completed": return THREAD_STATUS_TEXT.done;
    case "failed": return THREAD_STATUS_TEXT.failed;
    case "interrupted":
    case "cancelled": return THREAD_STATUS_TEXT.stopped;
    default: return null;
  }
}

export interface BackgroundThreadSnapshot {
  key: string;
  title: string;
  request: "approval" | "input" | null;
  requestId: string | null;
  runId: string | null;
  runStatus: string | null;
  /** The run doing work now, which can be older than a queued run cancelled while it ran. */
  activeRunId: string | null;
  snoozed: boolean;
}

interface BackgroundMemoryEntry { request: BackgroundThreadSnapshot["request"]; requestId: string | null; settledRunId: string | null }
export type BackgroundThreadMemory = ReadonlyMap<string, BackgroundMemoryEntry>;

/** First sightings are a silent baseline, so opening the app or reconnecting does not read out every thread. */
export function nextBackgroundThreadAnnouncement(previous: BackgroundThreadMemory, threads: ReadonlyArray<BackgroundThreadSnapshot>, openThreadKey: string | null): { memory: BackgroundThreadMemory; announcement: string | null } {
  const memory = new Map<string, BackgroundMemoryEntry>();
  const announcements: string[] = [];
  for (const thread of threads) {
    const before = previous.get(thread.key);
    const outcome = runOutcomeText(thread.runStatus);
    const settled = outcome !== null || thread.runStatus === "rolled_back";
    memory.set(thread.key, { request: thread.request, requestId: thread.requestId, settledRunId: settled ? thread.runId : (before?.settledRunId ?? null) });
    if (before === undefined || thread.key === openThreadKey || thread.snoozed) continue;
    if (thread.request !== null && (thread.request !== before.request || thread.requestId !== before.requestId)) {
      announcements.push(`${THREAD_STATUS_TEXT[thread.request]}: ${thread.title}`);
    }
    // While another run still works, the latest run's ending is not the thread finishing.
    const anotherRunWorking = thread.activeRunId !== null && thread.activeRunId !== thread.runId;
    if (outcome !== null && thread.runId !== before.settledRunId && !anotherRunWorking) announcements.push(`${outcome}: ${thread.title}`);
  }
  return { memory, announcement: announcements.length === 0 ? null : announcements.join(". ") };
}

/** A thread of the shell snapshot, as the announcer reads it. */
export function backgroundSnapshotOf(thread: Thread, now: number): BackgroundThreadSnapshot {
  const meta = thread.meta;
  const kind = meta?.pendingRequestKind ?? null;
  const request = kind === null ? null : kind === "user_input" ? "input" : "approval";
  return {
    key: thread.id,
    title: thread.title,
    request,
    requestId: null,
    runId: meta?.latestRunId ?? null,
    runStatus: meta?.runStatus ?? null,
    activeRunId: meta?.activeRunId ?? null,
    snoozed: meta?.snoozedUntil != null && meta.snoozedUntil > now,
  };
}
