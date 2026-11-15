import { showToast } from "../toast/toastState";
// ComposerBannerStack.tsx and the items ChatView builds for it: the notices about sending from this composer, each
// an attached card stacked above it. Order: usage-limit recovery, the Pi extension status, the composer's own cards
// (usage limits, fresh session), the environment and server-update notices, then the branch mismatch; stably grouped
// so the machine's notices come before what needs you. Mount it as the first child of the composer's column,
// replacing the inline fresh-session, usage-limit, provider-status and disconnected notices.
import { computed, effect, signal, View } from "nsh";
import { allProjects, backendError, backendStatus, backendUrl, composerDraft, configureBackend, isServerThread, listedRuntimeModes, openThread, publishLocalCheckoutBranch, runtimeMode, setFreshContext, setRuntimeMode, settingValue, subscribeBackend } from "../../store";
import { NoticeCard } from "./BannerParts";
import type { BannerItem } from "./bannerTypes";
import { projectCloneBannerItem } from "../palette/addProject/addProjectState";
import {
  branchMismatchItem, branchMismatchKey, environmentUnavailableItem, extensionStatusItem, formatUpcomingTimestamp, limitRecoveryActive, orderComposerBanners,
  resolveLocalCheckoutBranchMismatch, shouldShowBranchMismatchBanner, usageLimitRecoveryItem, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS, ENVIRONMENT_DISCONNECT_DELAY_MS,
} from "./bannerLogic";
import {
  branchMismatchTick, copyAdminRequest, dismissBranchMismatchForSession, dismissServerUpdateFailure, isBranchMismatchDismissedForSession, limitRecoverySaving, openChatGptUsage,
  restoreThreadBranch, restoringBranchThreadId, revealedBranchMismatchKey, serverUpdateFailureDismissed, serverUpdateState, updateLimitRecovery,
} from "./bannerRuntime";
import { serverUpdateItem } from "./serverUpdate";
import { canRetryServerUpdate, machineUpdateStates, retryServerUpdate } from "../../environments/ServerUpdateAction";
import { autoBalanceUpdateItem } from "../../environments/autoBalanceUpdates";
import { autoEnvironmentLabel } from "../../environments/loadBalancing";
import { providerExtensionStatuses, threadSessionState } from "./threadSessionState";
import { dismissFeedbackSubmission, feedbackBannerItem, feedbackSubmissionsFor } from "../composer/codexFeedback";
import { serverEnvironmentLabel } from "./serverCaps";
import { environmentConnections, managedEnvironment, reconnectEnvironment } from "../../environments/connectionManager";
import { savedEnvironments, setSavedEnvironmentEnabled } from "../../pages/settings/environments/savedEnvironments";
import { managedRuntimeModeItem } from "../composer/runtimeModeConfig";
import { serverManagedPolicy } from "../../pages/settings/settingsState";
import { watchVcsStatus } from "../header/gitRuntime";
import type { VcsStatus } from "../header/gitLogic";
import { asTimestampFormat } from "../thread/timestampFormat";

/** The attached stack: consecutive cards join edge to edge, the first rounds its top, and the last joins the composer below. */
export function ComposerBannerStack(props: { items: () => BannerItem[] }) {
  return (
    <View testID="Composer banners">
      <Each of={props.items()} key={(item) => item.id}>
        {(item) => <NoticeCard item={item()} first={props.items()[0]?.id === item().id} last={props.items()[props.items().length - 1]?.id === item().id} />}
      </Each>
    </View>
  );
}

export interface ComposerBannersProps {
  /** The `/clear` card: the composer owns whether a fresh session is armed and available. */
  freshSession?: () => { available: boolean; armed: boolean };
  /** The composer-owned usage-limits card (its windows and bars), placed where the reference stacks it. */
  usageLimits?: () => unknown;
  /** The composer paints its own connection notice, so the environment item is left out. */
  hideEnvironment?: boolean;
  /** Test seams. */
  composerHasContent?: () => boolean;
  now?: () => number;
}

export function freshSessionItem(onUndo: () => void): BannerItem {
  return {
    id: "fresh-session", variant: "default", icon: "eraser", title: "Your next message starts a fresh session",
    description: "The agent won't see earlier messages in this thread.", actions: [{ id: "undo", label: "Undo", tone: "button", run: onUndo }],
  };
}

export function ComposerBanners(props: ComposerBannersProps = {}) {
  const now = props.now ?? (() => Date.now());
  const thread = () => openThread();
  const project = () => allProjects().find((item) => item.id === thread()?.projectId);
  const shell = () => thread()?.banner;
  const server = () => { const current = thread(); return Boolean(current && isServerThread(current.id)); };

  // The current branch of the checkout the thread runs in: the project's status stream.
  const status = signal<VcsStatus | null>(null);
  // The stream is keyed by what it depends on, as values: the thread and project objects are rebuilt on every shell
  // update, and reading them here resubscribed (one subscribeVcsStatus request each) for every such update.
  const statusCwd = computed(() => (backendStatus() === "connected" && server() ? project()?.path ?? null : null));
  effect(() => {
    const cwd = statusCwd();
    status.set(null);
    if (!cwd) return;
    return watchVcsStatus(cwd, subscribeBackend, (next) => status.set(next), () => status.set(null));
  });

  // Each reconnect attempt gets its own grace period before the offline notice shows.
  const graceElapsed = signal(false);
  effect(() => {
    const connecting = backendStatus() === "connecting";
    graceElapsed.set(false);
    if (!connecting) return;
    const timer = setTimeout(() => graceElapsed.set(true), ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
    return () => clearTimeout(timer);
  });

  // A thread of a saved environment reports that environment's connection (useSystemComposerBanners activeEnvironment).
  const remoteEnvironmentId = () => thread()?.environmentId ?? null;
  const remoteStatus = (): "disconnected" | "connecting" | "connected" | "error" => {
    const phase = environmentConnections()[remoteEnvironmentId() ?? ""]?.phase;
    return phase === "connected" ? "connected" : phase === "connecting" || phase === "reconnecting" ? "connecting" : phase === "error" ? "error" : "disconnected";
  };
  const remoteGraceElapsed = signal(false);
  effect(() => {
    const connecting = remoteEnvironmentId() !== null && remoteStatus() === "connecting";
    remoteGraceElapsed.set(false);
    if (!connecting) return;
    const timer = setTimeout(() => remoteGraceElapsed.set(true), ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
    return () => clearTimeout(timer);
  });
  // useEnvironmentDisconnectDelay: Disconnect server shows once the same environment stayed unavailable for 20 s.
  const disconnectReady = signal(false);
  effect(() => {
    const id = remoteEnvironmentId();
    const unavailable = id !== null && remoteStatus() !== "connected";
    disconnectReady.set(false);
    if (!unavailable) return;
    const timer = setTimeout(() => disconnectReady.set(true), ENVIRONMENT_DISCONNECT_DELAY_MS);
    return () => clearTimeout(timer);
  });
  const disconnectRemote = (id: string) => {
    try { setSavedEnvironmentEnabled(id, false); }
    catch (error) { showToast({ type: "error", title: "Could not disconnect server", description: error instanceof Error ? error.message : "Failed to disconnect." }); }
  };
  // "<env> server" once more than one environment is registered.
  const dismissedRemoteFailures = signal<unknown[]>([]);
  const updateServerLabel = () => savedEnvironments().length > 0 ? `${serverEnvironmentLabel()} server` : "server";

  const items = computed<BannerItem[]>(() => {
    const current = thread();
    const info = shell();
    const timestampFormat = asTimestampFormat(settingValue("timestampFormat"));
    const out: BannerItem[] = [];
    // Usage-limit recovery.
    if (current && info && limitRecoveryActive(info) && info.latestRunId) {
      out.push(usageLimitRecoveryItem({
        runId: info.latestRunId, errorCode: info.lastErrorCode, resetAt: info.usageLimitResetAt, stoppedAt: info.latestRunStoppedAt ?? new Date(0).toISOString(),
        settled: info.settledOverride === "settled", requestPending: info.pendingRequestKind !== null, snoozedUntil: info.snoozedUntil, recovery: info.limitRecovery, now: now(),
        formatUpcoming: (iso) => formatUpcomingTimestamp(iso, timestampFormat, now()), pending: limitRecoverySaving(),
        onToggle: (action) => {
          const recovery = info.limitRecovery;
          const scheduled = recovery?.runId === info.latestRunId && recovery.resetAt === info.usageLimitResetAt && recovery.autoResume;
          const snoozed = recovery?.runId === info.latestRunId && recovery.resetAt === info.usageLimitResetAt && recovery.snooze === true && Boolean(info.snoozedUntil);
          if (!info.usageLimitResetAt || !info.latestRunId) return;
          if (action === "snooze" && !snoozed && Date.parse(info.usageLimitResetAt) <= now()) {
            // UsageLimitRecoveryBanner: a snooze whose reset already passed is refused with this toast; nothing is sent.
            showToast({ type: "error", title: "Could not snooze thread", description: "The reset time has passed. Retry the thread manually." });
            return;
          }
          void updateLimitRecovery(current.id, { runId: info.latestRunId, resetAt: info.usageLimitResetAt, ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }) }, action === "resume" ? "Could not change auto-resume" : "Could not snooze thread");
        },
        onCopyAdminRequest: copyAdminRequest, onOpenChatGptUsage: openChatGptUsage,
      }));
    }
    // The Codex /feedback upload notices (ComposerFeedback.tsx).
    if (current) for (const submission of feedbackSubmissionsFor(current.id)) {
      const item = feedbackBannerItem(submission, () => dismissFeedbackSubmission(current.id, submission.id));
      if (item) out.push(item);
    }
    // The Pi extension status.
    const extension = extensionStatusItem(providerExtensionStatuses(threadSessionState()));
    if (extension) out.push(extension);
    // The fresh session card.
    const fresh = props.freshSession?.();
    if (current && fresh?.available && fresh.armed) out.push(freshSessionItem(() => setFreshContext(current.id, false)));
    // useProjectCloneBanner: the project is still being cloned or copied into place.
    const cloneBanner = projectCloneBannerItem(project()?.id ?? current?.projectId);
    if (cloneBanner) out.push(cloneBanner);
    // A thread above the administrator's runtime-mode ceiling (ChatComposer's managed-runtime-mode item).
    const managed = current ? managedRuntimeModeItem({ policy: serverManagedPolicy(), mode: runtimeMode(), modes: listedRuntimeModes(), onSwitch: (mode) => { void setRuntimeMode(mode).catch(() => {}); } }) : null;
    if (managed) out.push(managed);
    // The environment and the server update.
    const remoteId = remoteEnvironmentId();
    const environment = remoteId
      ? environmentUnavailableItem({
        status: remoteStatus(), label: managedEnvironment(remoteId)?.label ?? remoteId, error: environmentConnections()[remoteId]?.error ?? null, graceElapsed: remoteGraceElapsed(), updateRunning: false,
        onReconnect: () => reconnectEnvironment(remoteId),
        ...(disconnectReady() ? { onDisconnect: () => disconnectRemote(remoteId) } : {}),
      })
      : environmentUnavailableItem({
        status: backendStatus(), label: serverEnvironmentLabel(), error: backendError(), graceElapsed: graceElapsed(), updateRunning: serverUpdateState().status === "running",
        onReconnect: () => { const url = backendUrl(); if (url) configureBackend(url); },
      });
    // The open thread's own machine: the primary's update state, or the saved environment's (machineUpdateStates).
    const automaticEnvironment = autoEnvironmentLabel() !== undefined;
    const remoteUpdateState = remoteId ? machineUpdateStates()[remoteId] ?? { status: "idle" as const } : null;
    const update = remoteId
      ? serverUpdateItem({ state: remoteUpdateState!, failureDismissed: dismissedRemoteFailures().includes(remoteUpdateState!), automaticEnvironment, serverLabel: `${managedEnvironment(remoteId)?.label ?? remoteId} server`, canRetry: false, onRetry: () => {}, onDismiss: () => dismissedRemoteFailures.update((list) => [...list, remoteUpdateState!]) })
      : serverUpdateItem({ state: serverUpdateState(), failureDismissed: serverUpdateFailureDismissed(), automaticEnvironment, serverLabel: updateServerLabel(), canRetry: canRetryServerUpdate(), onRetry: () => { void retryServerUpdate(); }, onDismiss: () => dismissServerUpdateFailure(serverUpdateState()) });
    // useAutoBalanceUpdateBanner: an automatic draft gets one notice for all its machines.
    const autoBalanceUpdate = automaticEnvironment ? autoBalanceUpdateItem() : null;
    if (autoBalanceUpdate) out.push(autoBalanceUpdate);
    if (update) out.push(update);
    // The branch mismatch: a local-checkout thread whose checkout moved off the branch it last ran on.
    branchMismatchTick();
    const mismatch = server() ? resolveLocalCheckoutBranchMismatch({ local: info?.worktreePath == null, worktreePath: info?.worktreePath ?? null, threadBranch: info?.branch ?? null, currentBranch: status()?.refName ?? null }) : null;
    const key = branchMismatchKey(current?.id ?? null, mismatch);
    if (current) publishLocalCheckoutBranch(current.id, mismatch?.currentBranch ?? null);
    const hasContent = props.composerHasContent ? props.composerHasContent() : composerDraft().trim().length > 0;
    const show = shouldShowBranchMismatchBanner({ hasMismatch: mismatch !== null, isDismissed: isBranchMismatchDismissedForSession(key), composerHasContent: hasContent, wasShownForCurrentMismatch: revealedBranchMismatchKey() !== null && revealedBranchMismatchKey() === key });
    if (current && mismatch && key && show) {
      out.push(branchMismatchItem({
        key, mismatch, restoring: restoringBranchThreadId() === current.id, restoreDisabled: restoringBranchThreadId() === current.id || !project()?.path,
        onRestore: () => { const cwd = project()?.path; if (cwd) void restoreThreadBranch({ threadId: current.id, cwd, branch: mismatch.threadBranch, hasWorkingTreeChanges: status()?.hasWorkingTreeChanges === true, currentThreadBranch: info?.branch ?? null }); },
        onDismiss: () => dismissBranchMismatchForSession(key),
      }));
    }
    return orderComposerBanners(out);
  });

  // The banner stays up once shown for a mismatch, even after the draft is sent or cleared.
  effect(() => {
    const visible = items().find((item) => item.id.startsWith("branch-mismatch:"));
    if (visible) revealedBranchMismatchKey.set(visible.id.slice("branch-mismatch:".length));
  });

  return <ComposerBannerStack items={items} />;
}
