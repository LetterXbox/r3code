// hooks/useProactivePanels.ts: opens the right panel on its own when there is something new to look at, a change request linked to the thread or
// the diff of a turn that just completed (the `proactivePanelsEnabled` setting). A panel the user opened or closed since wins:
// the user-action revision of the thread's panel is read when a turn starts and again when the panel is offered, and a change in between
// refuses the offer. The decisions are the web's (ChatView.logic.ts), ported unchanged; `createProactivePanels` runs them against a host so
// the rules are testable, and `installProactivePanels` binds them to the open thread and the right panel.
//
// Differences from the web, from what the port can read: the thread's checkpoints come from the open thread's projection (store.ts
// `threadCheckpoints`); a ready checkpoint is a git ref, so it stands for "is a git repository" (the web asks the git status); the linked
// change request is the newest visible link of the thread's shell (the web also resolves the thread's branch against the git status); the
// diff opens its single tab, as the port's diff has no per-turn selection.
import { effect, untracked } from "nsh";
import { settingValue, backendStatus, isServerThread, openThread, threadCheckpoints, threadSyncPhase } from "../../store";
import type { Thread } from "../../store";
import { panelKeyFor, panelStateFor, updatePanel } from "../rightPanel/panelState";
import { openPullRequestsSurface, openPullRequestSurface, openSurface, pullRequestSurfaceId, type PanelState, type Surface } from "../rightPanel/panelLogic";
import type { LinkedPullRequest } from "../header/threadRelations";
import { visibleThreadPullRequests } from "../pullRequest/threadPullRequests.logic";

export interface CheckpointSummary {
  runId: string;
  status: string;
  files: ReadonlyArray<{ additions: number; deletions: number }>;
  filesTotal?: { count: number; additions: number; deletions: number };
}

export interface LinkedTarget { projectId: string; host: string; repository: string; number: number; url: string }

export interface ProactiveObservation {
  threadKey: string;
  runningTurnId: string | null | undefined;
  targetKey: string | null | undefined;
  userActionTurnId: string | null;
  userActionRevision: number;
}

export function shouldOpenProactivePullRequest(previousTargetKey: string | null | undefined, targetKey: string | null): boolean {
  return targetKey !== null && targetKey !== previousTargetKey;
}

export function observeProactivePanelUserChoice(
  previous: ProactiveObservation | null,
  input: { threadKey: string; runningTurnId: string | null; userActionRevision: number },
): ProactiveObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newTurn = sameThread && input.runningTurnId !== null && input.runningTurnId !== previous.userActionTurnId;
  return {
    threadKey: input.threadKey,
    runningTurnId: sameThread ? previous.runningTurnId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionTurnId: input.runningTurnId ?? (sameThread ? previous.userActionTurnId : null),
    userActionRevision: !sameThread || newTurn ? input.userActionRevision : previous.userActionRevision,
  };
}

export function shouldRetargetThreadPullRequestPanel(previous: LinkedTarget | null, current: LinkedTarget | null, surface: Surface | null): boolean {
  if (previous === null || current === null || surface?.kind !== "pull-request") return false;
  const previousRepository = previous.repository.toLowerCase();
  return (
    (previous.projectId !== current.projectId || previousRepository !== current.repository.toLowerCase() || previous.number !== current.number)
    && surface.projectId === previous.projectId
    && (surface.repository ?? "").toLowerCase() === previousRepository
    && surface.number === previous.number
  );
}

export function shouldOpenProactiveTurnDiff(input: {
  previousRunningTurnId: string | null | undefined;
  runningTurnId: string | null;
  settledTurnId: string | null;
  turnCompleted: boolean;
}): boolean {
  return input.runningTurnId === null && input.turnCompleted && input.settledTurnId !== null
    && (input.previousRunningTurnId === undefined || input.settledTurnId === input.previousRunningTurnId);
}

/** checkpointFileTotals: the server's totals when it sent them, else summed from the files it listed. */
export function checkpointFileTotals(checkpoint: Pick<CheckpointSummary, "files" | "filesTotal">): { count: number; additions: number; deletions: number } {
  if (checkpoint.filesTotal) return checkpoint.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) { additions += file.additions; deletions += file.deletions; }
  return { count: checkpoint.files.length, additions, deletions };
}

export function resolveProactiveTurnDiffAction(input: { checkpoint: CheckpointSummary | undefined; isGitRepo: boolean | undefined }): "defer" | "ignore" | "open" {
  if (input.checkpoint === undefined || input.checkpoint.status === "missing") return "defer";
  if (input.isGitRepo === undefined) return "defer";
  if (!input.isGitRepo || input.checkpoint.status !== "ready" || input.checkpoint.files.length === 0) return "ignore";
  const totals = checkpointFileTotals(input.checkpoint);
  return totals.count >= 3 || totals.additions + totals.deletions >= 50 ? "open" : "ignore";
}

export type ProactiveRequest =
  | { kind: "diff"; turnId: string }
  | { kind: "pull-requests" }
  | { kind: "pull-request"; target: LinkedTarget };

/** What the stepper needs from the right panel of the thread. */
export interface ProactivePanelsHost {
  userActionRevision(): number;
  /** The tab in front while the panel is shown; null when it is hidden or has none. */
  activeSurface(): Surface | null;
  /** The web's openProactive: false when the user acted since `expectedRevision`, or the panel already shows something that outranks it. */
  openProactive(request: ProactiveRequest, expectedRevision: number, activateExisting?: boolean): boolean;
}

export interface ProactiveInput {
  threadKey: string | null;
  enabled: boolean;
  settingsHydrated: boolean;
  threadDetailLoading: boolean;
  runningTurnId: string | null;
  latestRun: { runId: string; status: string } | null;
  latestRunSettled: boolean;
  checkpoints: ReadonlyArray<CheckpointSummary & { runId: string }>;
  isGitRepo: boolean | undefined;
  linkedPullRequest: LinkedTarget | null;
  hasLinkedPullRequestDetail: boolean;
  pullRequestsKey: string | null;
  pullRequestsCapabilityKnown: boolean;
  supportsPullRequests: boolean;
  pullRequestsSurfaceAvailable: boolean;
  visiblePullRequestCount: number;
}

/** Settings and drafts unmount the thread; the web remembers links until the page reloads. */
const observedThreadPullRequests = new Map<string, LinkedTarget | null>();

/** One stepper for the whole window, as the web's single ref: moving to another thread starts the observation over. */
export function createProactivePanels(hostFor: (threadKey: string) => ProactivePanelsHost) {
  let observation: ProactiveObservation | null = null;

  return function step(input: ProactiveInput | null): void {
    if (input === null || input.threadKey === null) { observation = null; return; }
    const { threadKey } = input;
    const host = hostFor(threadKey);
    const next = observeProactivePanelUserChoice(observation, { threadKey, runningTurnId: input.runningTurnId, userActionRevision: host.userActionRevision() });
    observation = next;
    const { runningTurnId: previousRunningTurnId, targetKey: previousTargetKey, userActionRevision } = next;
    const openSurface = host.activeSurface();
    const previousPullRequest = observedThreadPullRequests.get(threadKey) ?? null;
    // A missing link during loading must not erase the last observed one.
    if (input.linkedPullRequest !== null || !input.threadDetailLoading) observedThreadPullRequests.set(threadKey, input.linkedPullRequest);
    const followSelectedPullRequest = shouldRetargetThreadPullRequestPanel(previousPullRequest, input.linkedPullRequest, openSurface);
    // Following the selected linked PR does not open an unrelated panel, so it remains available with proactive panels off.
    if (followSelectedPullRequest && input.linkedPullRequest !== null) {
      host.openProactive({ kind: "pull-request", target: input.linkedPullRequest }, userActionRevision, true);
    }
    if (!input.settingsHydrated) return;

    const eligibleLink = input.enabled && shouldOpenProactivePullRequest(previousTargetKey, input.pullRequestsKey);
    const shouldDeferLink = eligibleLink && !input.pullRequestsCapabilityKnown;
    observation = { ...next, targetKey: shouldDeferLink ? (previousTargetKey ?? null) : input.pullRequestsKey };
    if (eligibleLink && input.pullRequestsCapabilityKnown) {
      if (!followSelectedPullRequest && input.pullRequestsSurfaceAvailable && (input.visiblePullRequestCount > 1 || !input.hasLinkedPullRequestDetail || !input.supportsPullRequests)) {
        host.openProactive({ kind: "pull-requests" }, userActionRevision);
      } else if (!followSelectedPullRequest && input.supportsPullRequests && input.linkedPullRequest !== null) {
        host.openProactive({ kind: "pull-request", target: input.linkedPullRequest }, userActionRevision);
      }
    }
    if (input.threadDetailLoading) return;

    const settledTurnId = input.latestRunSettled ? (input.latestRun?.runId ?? null) : null;
    const newlyCompletedTurnId = shouldOpenProactiveTurnDiff({
      previousRunningTurnId,
      runningTurnId: input.runningTurnId,
      settledTurnId,
      turnCompleted: input.latestRun?.status === "completed",
    }) ? settledTurnId : null;
    const eligibleCompletion = input.enabled && newlyCompletedTurnId !== null
      && !(input.pullRequestsKey !== null && (!input.pullRequestsCapabilityKnown || input.supportsPullRequests || input.pullRequestsSurfaceAvailable));
    const completedCheckpoint = eligibleCompletion ? input.checkpoints.find((checkpoint) => checkpoint.runId === newlyCompletedTurnId) : undefined;
    const diffAction = eligibleCompletion ? resolveProactiveTurnDiffAction({ checkpoint: completedCheckpoint, isGitRepo: input.isGitRepo }) : "ignore";
    observation = {
      ...observation,
      // Preserve first-entry eligibility while capabilities, checkpoint or repository load.
      runningTurnId: diffAction === "defer" || shouldDeferLink ? previousRunningTurnId : input.runningTurnId,
    };
    if (diffAction !== "open" || newlyCompletedTurnId === null) return;
    host.openProactive({ kind: "diff", turnId: newlyCompletedTurnId }, userActionRevision);
  };
}

// --- the right panel as the host ------------------------------------------------------------------------------------------------------

interface UserActionRecord { lastState: PanelState; revision: number }
const userActions = new Map<string, UserActionRecord>();
/** The turn whose diff was last offered per thread (`proactiveDiffTurnId`): a refused offer is not retried on a revisit. */
const offeredDiffTurn = new Map<string, string>();

/**
 * getUserActionRevision: counts the changes to the thread's panel state that did not come from here. The first look is the baseline;
 * every later change of the state (a tab opened or closed, the panel hidden) is the user's.
 */
function userActionRevision(key: string): number {
  const state = untracked(() => panelStateFor(key));
  const record = userActions.get(key);
  if (!record) { userActions.set(key, { lastState: state, revision: 0 }); return 0; }
  if (record.lastState !== state) { record.lastState = state; record.revision += 1; }
  return record.revision;
}

function applyAutomatic(key: string, change: (state: PanelState) => PanelState) {
  // Settle what the user changed so far first, so this change is not counted as theirs.
  userActionRevision(key);
  updatePanel(key, change);
  const record = userActions.get(key);
  if (record) record.lastState = untracked(() => panelStateFor(key));
}

export function panelHostFor(key: string): ProactivePanelsHost {
  return {
    userActionRevision: () => userActionRevision(key),
    activeSurface: () => {
      const state = untracked(() => panelStateFor(key));
      return state.open ? (state.surfaces.find((surface) => surface.id === state.activeId) ?? null) : null;
    },
    openProactive(request, expectedRevision, activateExisting = false) {
      const revision = userActionRevision(key);
      const state = untracked(() => panelStateFor(key));
      if (request.kind === "diff") {
        if (offeredDiffTurn.get(key) === request.turnId) return false;
        const active = state.open ? (state.surfaces.find((surface) => surface.id === state.activeId) ?? null) : null;
        const pullRequestActive = active?.kind === "pull-request" || active?.kind === "pull-requests";
        const opened = revision === expectedRevision && active?.kind !== "diff" && !pullRequestActive;
        // Record the offer even when refused, so a revisit does not retry this turn.
        offeredDiffTurn.set(key, request.turnId);
        if (opened) applyAutomatic(key, (current) => openSurface(current, "diff"));
        return opened;
      }
      if (revision !== expectedRevision) return false;
      if (request.kind === "pull-requests") {
        applyAutomatic(key, openPullRequestsSurface);
        return true;
      }
      const target = { projectId: request.target.projectId, host: request.target.host, repository: request.target.repository, number: request.target.number, url: request.target.url };
      // Keep an existing PR tab where the user left it when revisiting a thread.
      if (!activateExisting && state.surfaces.some((surface) => surface.id === pullRequestSurfaceId(target))) return false;
      applyAutomatic(key, (current) => openPullRequestSurface(current, target));
      return true;
    },
  };
}

// --- reading the open thread ----------------------------------------------------------------------------------------------------------

const SETTLED_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** The thread's newest visible link, as the target the panel opens. */
export function linkedTargetOf(thread: Thread): LinkedTarget | null {
  const links: LinkedPullRequest[] = visibleThreadPullRequests(thread.relations?.pullRequests ?? []);
  const newest = [...links].sort((a, b) => (Date.parse(b.linkedAt) || 0) - (Date.parse(a.linkedAt) || 0))[0];
  return newest ? { projectId: thread.projectId, host: newest.host, repository: newest.repository, number: newest.number, url: newest.url } : null;
}

export function checkpointSummaries(rows: readonly Record<string, unknown>[]): Array<CheckpointSummary & { runId: string }> {
  const out: Array<CheckpointSummary & { runId: string }> = [];
  for (const row of rows) {
    if (typeof row.runId !== "string" || typeof row.status !== "string" || row.appRunOrdinal === null || row.appRunOrdinal === undefined) continue;
    const files = Array.isArray(row.files) ? row.files.flatMap((file) => {
      const entry = typeof file === "object" && file !== null ? file as Record<string, unknown> : null;
      return entry ? [{ additions: typeof entry.additions === "number" ? entry.additions : 0, deletions: typeof entry.deletions === "number" ? entry.deletions : 0 }] : [];
    }) : [];
    const total = typeof row.filesTotal === "object" && row.filesTotal !== null ? row.filesTotal as Record<string, unknown> : null;
    const filesTotal = total && typeof total.count === "number" && typeof total.additions === "number" && typeof total.deletions === "number"
      ? { count: total.count, additions: total.additions, deletions: total.deletions } : undefined;
    out.push({ runId: row.runId, status: row.status, files, ...(filesTotal ? { filesTotal } : {}) });
  }
  return out;
}

/** The step's input for `thread`, or null for a thread the panel does not apply to (a draft, none open). */
export function proactiveInputFor(thread: Thread | undefined): ProactiveInput | null {
  if (!thread || !isServerThread(thread.id)) return null;
  const meta = thread.meta;
  const links = visibleThreadPullRequests(thread.relations?.pullRequests ?? []);
  const linked = linkedTargetOf(thread);
  const connected = backendStatus() === "connected";
  const checkpoints = checkpointSummaries(threadCheckpoints());
  const runningTurnId = meta?.activeRunId ?? null;
  const latestRunId = meta?.latestRunId ?? null;
  const latestRun = latestRunId ? { runId: latestRunId, status: meta?.runStatus ?? "idle" } : null;
  const completed = latestRun ? checkpoints.find((checkpoint) => checkpoint.runId === latestRun.runId) : undefined;
  return {
    threadKey: panelKeyFor(thread.id),
    enabled: settingValue("proactivePanelsEnabled") === true,
    settingsHydrated: true,
    threadDetailLoading: threadSyncPhase() === "loading",
    runningTurnId,
    latestRun,
    latestRunSettled: runningTurnId === null && latestRun !== null && SETTLED_RUN_STATUSES.has(latestRun.status),
    checkpoints,
    // A ready checkpoint is a git ref: it stands for "is a git repository". A missing one defers.
    isGitRepo: completed ? completed.status === "ready" : undefined,
    linkedPullRequest: linked,
    hasLinkedPullRequestDetail: links.some((link) => link.snapshot !== null),
    pullRequestsKey: links.length > 0 ? JSON.stringify(links.map((link) => [link.host, link.repository, link.number]).sort()) : null,
    pullRequestsCapabilityKnown: connected,
    supportsPullRequests: connected,
    pullRequestsSurfaceAvailable: connected && links.length > 0,
    visiblePullRequestCount: links.length,
  };
}

let installed = false;

/** Opens the diff after a turn completes and the linked pull request panel when one appears, for the open server thread. */
export function installProactivePanels() {
  if (installed) return;
  installed = true;
  const step = createProactivePanels(panelHostFor);
  effect(() => {
    const input = proactiveInputFor(openThread());
    untracked(() => step(input));
  });
}

/** Tests only: forget what was observed. */
export function resetProactivePanelsForTest() {
  observedThreadPullRequests.clear();
  userActions.clear();
  offeredDiffTurn.clear();
}
