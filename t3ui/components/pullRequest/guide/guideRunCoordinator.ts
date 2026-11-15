// guideRunStore.ts + PullRequestGuideRunCoordinator.tsx: a guide being written is watched (polled every 5 s through
// pullRequests.reviewGuide) until it settles, then announced with "Review guide ready" / "Review guide failed" and an
// "Open guide" action, unless that guide is already on screen. Desktop notifications and sounds are not ported (the
// runtime has no notification API); the toast is shown whether or not the window is focused.
import { signal } from "nsh";
import { showToast, closeToast } from "../../toast";
import { openUtility } from "../../../store";
import { pullRequestReviewKey } from "../pullRequestReviewStore";
import type { PullRequestRefInput } from "../pullRequestDiff.logic";

export const RUN_POLL_MS = 5_000;
export const UNSEEN_RUN_MS = 60_000;

export interface GuideRunWatch {
  reference: PullRequestRefInput;
  title: string | null;
  previousGuideAt: string | null;
  previousFailedAt: string | null;
  since: number;
  answeredRunning?: boolean;
}

/** What one poll answered: the parts of PullRequestReviewGuideResult the watch reads. */
export interface GuidePoll { generatedAt: string | null; run: { tag: "Running" } | { tag: "Failed"; failedAt: string; detail: string } | null }

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

export const guideRunKey = (reference: PullRequestRefInput) => pullRequestReviewKey(reference);

const watches = new Map<string, { watch: GuideRunWatch; stop: () => void }>();
/** The guide tab on screen (the detail panel's data-guide-shown), by run key. */
const shownGuide = signal<string | null>(null);
export function setShownGuide(key: string | null) { shownGuide.set(key); }
/** An "Open guide" waiting for the Pull requests page: it selects the pull request and shows its Guide tab. */
const pendingOpen = signal<PullRequestRefInput | null>(null);
export const pendingGuideOpen = () => pendingOpen();
export function consumePendingGuideOpen() { pendingOpen.set(null); }

export function readGuidePoll(value: unknown): GuidePoll {
  const result = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const guide = result.guide as Record<string, unknown> | null | undefined;
  const run = result.run as Record<string, unknown> | null | undefined;
  return {
    generatedAt: guide && typeof guide.generatedAt === "string" ? guide.generatedAt : null,
    run: run?._tag === "Running" ? { tag: "Running" }
      : run?._tag === "Failed" ? { tag: "Failed", failedAt: typeof run.failedAt === "string" ? run.failedAt : "", detail: typeof run.detail === "string" ? run.detail : "" }
      : null,
  };
}

/** onGuide's decision for one answer: still running, settled quietly, or settled with an outcome to announce. */
export function guideOutcome(watch: GuideRunWatch, poll: GuidePoll, sawRunning: boolean, now: number): { kind: "running" } | { kind: "wait" } | { kind: "settle" } | { kind: "announce"; failure: string | null } {
  if (poll.run?.tag === "Running") return { kind: "running" };
  const failure = poll.run?.tag === "Failed" && poll.run.failedAt !== watch.previousFailedAt ? poll.run.detail : null;
  const written = failure === null && poll.generatedAt !== null && poll.generatedAt !== watch.previousGuideAt;
  if (failure === null && !written) return sawRunning || now - watch.since > UNSEEN_RUN_MS ? { kind: "settle" } : { kind: "wait" };
  return { kind: "announce", failure };
}

export function settleGuideRun(key: string) {
  const entry = watches.get(key);
  if (!entry) return;
  watches.delete(key);
  entry.stop();
}

export const isGuideRunWatched = (key: string) => watches.has(key);

/** useGuideRunStore.watch + watchGuideRun: one watch per pull request; a second start while one runs is ignored. */
export function watchGuideRun(watch: GuideRunWatch, request: Rpc, pollMs = RUN_POLL_MS) {
  const key = guideRunKey(watch.reference);
  if (watches.has(key)) return;
  let sawRunning = watch.answeredRunning === true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); };
  watches.set(key, { watch, stop });
  const poll = async () => {
    if (stopped) return;
    try {
      const answer = readGuidePoll(await request("pullRequests.reviewGuide", watch.reference));
      if (stopped) return;
      const outcome = guideOutcome(watch, answer, sawRunning, Date.now());
      if (outcome.kind === "running") sawRunning = true;
      else if (outcome.kind === "settle") { settleGuideRun(key); return; }
      else if (outcome.kind === "announce") { settleGuideRun(key); announce(key, watch, outcome.failure); return; }
    } catch {
      // A failed read is retried on the next poll, as the reference's query refresh does.
    }
    if (!stopped) timer = setTimeout(() => void poll(), pollMs);
  };
  timer = setTimeout(() => void poll(), pollMs);
}

function announce(key: string, watch: GuideRunWatch, failure: string | null) {
  if (shownGuide() === key) return;
  const body = watch.title ?? `${watch.reference.repository} #${watch.reference.number}`;
  const id = showToast({
    type: failure === null ? "success" : "error",
    title: failure === null ? "Review guide ready" : "Review guide failed",
    description: failure === null ? body : `${body}: ${failure}`,
    hideCopyButton: true,
    leadingIcon: failure === null ? { name: "circle-check", tone: "success" } : { name: "circle-alert", tone: "destructive" },
    actions: [{ label: "Open guide", run: () => { closeToast(id); pendingOpen.set(watch.reference); openUtility("pull-requests"); } }],
  });
}

/** useReviewGuideWriter's failure toast. */
export function guideStartFailed(reference: PullRequestRefInput, message: string | null) {
  settleGuideRun(guideRunKey(reference));
  showToast({ type: "error", title: "Could not start a review guide", description: message || "Check the review guide model in Settings → Source control." });
}

/** Tests start clean. */
export function resetGuideRunsForTests() { for (const key of [...watches.keys()]) settleGuideRun(key); shownGuide.set(null); pendingOpen.set(null); }
