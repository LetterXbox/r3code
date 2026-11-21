// The banners' state and RPCs: what was dismissed this session, and the actions their buttons run against the
// server (refresh a provider, stop and force-stop, change a usage-limit recovery, restore a branch).
import { Clipboard, openUrl, signal } from "nsh";
import { requestBackend, sendThreadCommand, stopThread } from "../../store";
import { confirm, showToast } from "../toast";
import { switchRef } from "../header/gitRuntime";
import { dismissThreadErrorBannerForSession, getThreadErrorBannerKey } from "../thread/timeline/threadError";
import { CHATGPT_USAGE_URL, CHATGPT_WORKSPACE_ADMIN_REQUEST, BACKGROUND_WORK_STOP_RETRY_AFTER_MS, type BackgroundWorkStopRequest } from "./bannerLogic";
import { serverUpdateState, type ServerUpdateState } from "./serverUpdate";
export { serverUpdateState };

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const commandId = () => `command:${crypto.randomUUID()}`;

// ---- Dismissals (per session, as the reference's module-level sets and state) ----

/** ProviderStatusBanner's dismissed key (ChatBannerLane's setDismissedProviderStatusBannerKey). */
export const dismissedProviderKey = signal<string | null>(null);
export const dismissProviderStatusBanner = (key: string | null) => dismissedProviderKey.set(key);

/** Re-renders the thread error banner after a dismissal (the reference's setThreadErrorBannerDismissTick). */
export const threadErrorDismissTick = signal(0);
export function dismissThreadError(threadKey: string, error: string | null, source: string | null = null): void {
  dismissThreadErrorBannerForSession(getThreadErrorBannerKey(threadKey, error, source));
  threadErrorDismissTick.update((tick) => tick + 1);
}

const dismissedBranchMismatch = new Set<string>();
export const branchMismatchTick = signal(0);
export const dismissBranchMismatchForSession = (key: string) => { dismissedBranchMismatch.add(key); branchMismatchTick.update((tick) => tick + 1); };
export const isBranchMismatchDismissedForSession = (key: string | null) => key !== null && dismissedBranchMismatch.has(key);
/** The mismatch key the banner was first shown for: it stays up once the draft empties (ChatView's revealedBranchMismatchKey). */
export const revealedBranchMismatchKey = signal<string | null>(null);

/** The server-update progress the composer notice shows; set by whatever starts a self-update (idle until then). */
const dismissedServerUpdate = signal<ServerUpdateState | null>(null);
export const dismissServerUpdateFailure = (state: ServerUpdateState) => dismissedServerUpdate.set(state);
export const serverUpdateFailureDismissed = () => dismissedServerUpdate() === serverUpdateState();

// ---- Actions ----

export function copyAdminRequest(): void {
  void Clipboard.writeText(CHATGPT_WORKSPACE_ADMIN_REQUEST).then(
    () => showToast({ type: "success", title: "Request copied", description: "Send it to your workspace admin." }),
    () => showToast({ type: "error", title: "Could not copy the request" }),
  );
}

export function openChatGptUsage(): void {
  void openUrl(CHATGPT_USAGE_URL).catch(() => showToast({ type: "error", title: "Could not open ChatGPT usage" }));
}

/** `/goal resume` and `/goal clear`: standalone commands sent to the thread without touching the draft. */
export async function sendGoalCommand(text: string, failureMessage: string): Promise<void> {
  try { await sendThreadCommand(text); } catch (cause) { showToast({ type: "error", title: failureMessage, description: message(cause, "") || undefined }); }
}

// A Stop that the background-work row sent stays pending while its tasks are listed (the reference's backgroundWorkStops).
const backgroundStops = signal<Record<string, BackgroundWorkStopRequest | undefined>>({});
const retryClock = signal(Date.now());
export const backgroundStopFor = (threadKey: string) => { retryClock(); return backgroundStops()[threadKey] ?? null; };

/** The interrupt path also accepts a completed run while its provider still has background work. */
export async function stopBackgroundWork(threadKey: string, taskIds: string[]): Promise<void> {
  const request: BackgroundWorkStopRequest = { threadKey, taskIds, retryAt: null };
  backgroundStops.update((all) => ({ ...all, [threadKey]: request }));
  try {
    stopThread();
    const retryAt = Date.now() + BACKGROUND_WORK_STOP_RETRY_AFTER_MS;
    backgroundStops.update((all) => (all[threadKey] !== request ? all : { ...all, [threadKey]: { ...request, retryAt } }));
    setTimeout(() => retryClock.set(Date.now()), BACKGROUND_WORK_STOP_RETRY_AFTER_MS + 50);
  } catch (cause) {
    backgroundStops.update((all) => (all[threadKey] !== request ? all : { ...all, [threadKey]: undefined }));
    showToast({ type: "error", title: "Failed to stop background work.", description: message(cause, "") || undefined });
  }
}

const forceStopping = signal<string | null>(null);
export const forceStoppingThreadId = () => forceStopping();

/** `orchestration.forceStopThread`; pass the run that ignored Stop so a Force stop left open cannot hit a newer run. */
export async function forceStopThread(threadId: string, runId?: string): Promise<void> {
  if (forceStopping() !== null) return;
  forceStopping.set(threadId);
  try {
    const result = await requestBackend("orchestration.forceStopThread", runId === undefined ? { threadId } : { threadId, runId });
    const value = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    const shared = Array.isArray(value.sharedWithThreadIds) ? value.sharedWithThreadIds.length : 0;
    if (value.outcome === "releasing") showToast({ type: "info", title: "Turn stopped; the agent is still shutting down" });
    if (value.outcome === "shared") {
      showToast({ type: "info", title: "Turn stopped; the agent process kept running", description: `It is shared with ${shared === 0 ? "other" : shared} working ${shared === 1 ? "thread" : "threads"}. Stop those to free it.` });
    }
  } catch (cause) {
    showToast({ type: "error", title: "Could not force stop the agent", description: message(cause, "") || undefined });
  } finally {
    forceStopping.set(null);
  }
}

const savingRecovery = signal(false);
export const limitRecoverySaving = () => savingRecovery();

/** `thread.metadata.update` with a `limitRecovery` change: auto-resume at the reset, or snooze until it. */
export async function updateLimitRecovery(threadId: string, update: { runId: string; resetAt: string; autoResume?: boolean; snooze?: boolean }, failureTitle: string): Promise<void> {
  savingRecovery.set(true);
  try {
    await requestBackend("orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: commandId(), threadId, limitRecovery: update });
  } catch (cause) {
    showToast({ type: "error", title: failureTitle, description: message(cause, "An error occurred.") });
  } finally {
    savingRecovery.set(false);
  }
}

const restoringBranch = signal<string | null>(null);
export const restoringBranchThreadId = () => restoringBranch();

/** Switches the local checkout back to the branch the thread last ran on, then records it on the thread. */
export async function restoreThreadBranch(input: { threadId: string; cwd: string; branch: string; hasWorkingTreeChanges: boolean; currentThreadBranch: string | null }): Promise<void> {
  if (restoringBranch() !== null) return;
  if (input.hasWorkingTreeChanges) {
    // ChatOverlayHosts BranchRestoreConfirm's copy and Switch branch action.
    const ok = await confirm(`Switch to ${input.branch}?\nYou have uncommitted changes. They'll carry over to the other branch, or block the switch if they conflict.`, { confirmLabel: "Switch branch" });
    if (!ok) return;
  }
  restoringBranch.set(input.threadId);
  try {
    let next: string | null;
    try { next = await switchRef(input.cwd, input.branch, requestBackend); }
    catch (cause) { showToast({ type: "error", title: "Failed to switch checkout", description: message(cause, "An error occurred.") }); return; }
    const settled = next ?? input.branch;
    if (settled !== input.currentThreadBranch) {
      try {
        await requestBackend("orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: commandId(), threadId: input.threadId, branch: settled, worktreePath: null });
      } catch (cause) {
        showToast({ type: "error", title: "Checkout switched, but the thread could not be updated", description: message(cause, "An error occurred.") });
      }
    }
  } finally {
    restoringBranch.set(null);
  }
}

/** `server.refreshProviders` via the store's refresh, for the provider banner's Refresh. */
export { refreshProviderStatuses } from "../../store";
