import { effect, signal, Storage, untracked } from "nsh";
import { settingValue } from "../../store";
import { RequestFailure } from "../../backend/client";
import type { PullRequestEntry } from "../../pages/utility-data";
import { createPullRequestActionsModel } from "./pullRequestActionsModel";
import { allowedMergeMethods, detailActionable } from "./pullRequestActions.logic";
import { createPullRequestGuideModel } from "./PullRequestGuideTab";
import { createPullRequestCodeModel } from "./pullRequestCodeModel";
import { createPullRequestReviewModel } from "./pullRequestReviewModel";
import { createPullRequestThreadLinksModel } from "./pullRequestThreadLinksModel";
import type { DiffFetchDeps } from "./pullRequestDiff.logic";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import { invalidatePullRequests, observePullRequestChecksAnswer, observePullRequestSummary, parsePullRequestChecks, pullRequestChecksRefreshIntervalMs, resolvePullRequestDetailChecks, usePullRequestRefreshes, type PullRequestChecksAnswer, type Subscribe } from "./pullRequestState";
import { pullRequestRefreshTick } from "./pullRequestState";
import {
  parseActivity, parseDetail, parseDetailCheck, parseStack, pullRequestChecksState, type DetailCheck, type PullRequestStackData, type PullRequestActivityData, type PullRequestDetailData,
} from "./pullRequestDetail.logic";

export type DetailTab = "summary" | "guide" | "timeline" | "code";
export type DetailStatus = "idle" | "loading" | "loaded" | "error";

// ---- Recent detail snapshots (pullRequestDetail.logic.ts read/writePullRequestDetailSnapshot) ----

const SNAPSHOT_INDEX_KEY = "t3.pullRequests.recentDetails";
const SNAPSHOT_LIMIT = 20;
type DetailRef = { projectId: string; host?: string; repository: string; number: number };

/** pullRequestDetailSnapshotKey (the port has one environment: its id is "local"). */
export function detailSnapshotKey(ref: DetailRef): string {
  return ref.host
    ? `t3.pullRequests.detail:${JSON.stringify(["local", ref.projectId, ref.host.toLowerCase(), ref.repository.toLowerCase(), ref.number])}`
    : `t3.pullRequests.detail:local:${ref.projectId}:${ref.repository}#${ref.number}`;
}

async function readDetailSnapshot(ref: DetailRef): Promise<unknown | null> {
  try {
    const text = await Storage.getItem(detailSnapshotKey(ref));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Only fresh reads are kept; the 20 most recent stay, the oldest goes first. */
function writeDetailSnapshot(ref: DetailRef, raw: unknown) {
  void (async () => {
    const key = detailSnapshotKey(ref);
    let recent: string[] = [];
    try { const parsed = JSON.parse((await Storage.getItem(SNAPSHOT_INDEX_KEY)) ?? "[]"); if (Array.isArray(parsed)) recent = parsed.filter((entry): entry is string => typeof entry === "string"); } catch { recent = []; }
    recent = recent.filter((entry) => entry !== key);
    recent.push(key);
    for (const evicted of recent.splice(0, Math.max(0, recent.length - SNAPSHOT_LIMIT))) await Storage.removeItem(evicted).catch(() => {});
    await Storage.setItem(SNAPSHOT_INDEX_KEY, JSON.stringify(recent));
    await Storage.setItem(key, JSON.stringify(raw));
  })().catch(() => {});
}

export function createPullRequestDetailModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  entry: () => PullRequestEntry | null;
  /** A row can disappear while its intent delay is running, without a pointer-leave event. */
  isListed?: (entry: PullRequestEntry) => boolean;
  http?: DiffFetchDeps;
  /** Linking threads is offered once an environment has delivered its config; the toast reports a refusal. */
  threadLinks?: { supported: () => boolean; toast: (input: { type: "error"; title: string; description: string }) => void };
  /** An action the host accepted on the open pull request (for the list's override). */
  onAction?: (action: string) => void;
  /** rightPanelStore's per-surface PR detail tab: the tab to start on, and where a change is remembered. */
  rememberedTab?: { read: () => DetailTab | null; write: (tab: DetailTab) => void };
  /** The live state layer (pullRequestState.ts): the refresh stream, and whether the server answers pullRequests.checks. */
  live?: { environmentId: () => string; connected: () => boolean; subscribe: Subscribe; supportsChecks: () => boolean };
}) {
  const detail = signal<PullRequestDetailData | null>(null);
  const activity = signal<PullRequestActivityData | null>(null);
  const stack = signal<PullRequestStackData | null>(null);
  /** Whether the stack read has answered (usePullRequestStack isFresh / error): merging alone waits for it. */
  const stackStatus = signal<"idle" | "loading" | "loaded" | "error">("idle");
  let stackKey = "";
  const status = signal<DetailStatus>("idle");
  const error = signal("");
  /** isPullRequestNotFound: the host answered PullRequestOperationError reason "not-found" for this reference. */
  const notFound = signal(false);
  const activityError = signal("");
  const tab = signal<DetailTab>("summary");
  let tabRestored = false;
  effect(() => { const current = tab(); if (tabRestored) untracked(() => deps.rememberedTab?.write(current)); });
  /** The Timeline tab's order, toggled from the tab bar (default newest first, as the web). */
  const timelineOrder = signal<"newest" | "oldest">("newest");
  const code = createPullRequestCodeModel({
    request: deps.request,
    ref: () => {
      const entry = deps.entry();
      return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
    },
    active: () => tab() === "code",
    http: deps.http ?? { endpoint: () => "", bearer: () => null, fetch },
    commits: () => activity()?.commits ?? null,
    viewedFiles: () => detail()?.capabilities.viewedFiles,
    initialIgnoreWhitespace: () => settingValue("diffIgnoreWhitespace") === true,
    initialWrap: () => settingValue("wordWrap") === true,
    revision: () => detail()?.updatedAt ?? null,
    backgroundToken: () => (deps.live ? pullRequestRefreshTick(deps.live.environmentId()) : 0),
  });
  const threadLinks = createPullRequestThreadLinksModel({
    request: deps.request,
    ref: () => {
      const entry = deps.entry();
      return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
    },
    target: () => { const entry = deps.entry(); return entry ? { host: entry.host, repository: entry.repository, number: entry.number, url: entry.url } : null; },
    supported: deps.threadLinks?.supported ?? (() => true),
    toast: deps.threadLinks?.toast ?? (() => undefined),
  });
  const review = createPullRequestReviewModel({
    ref: () => {
      const entry = deps.entry();
      return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
    },
    patch: () => code.patch(),
    detail: () => detail(),
    activity: () => activity(),
    commit: () => code.commit(),
  });
  const guide = createPullRequestGuideModel({
    http: deps.http ?? { endpoint: () => "", bearer: () => null, fetch },
    request: deps.request,
    title: () => deps.entry()?.title ?? null,
    ref: () => {
      const entry = deps.entry();
      return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
    },
  });
  let sequence = 0;
  // usePullRequestIntentPrefetch: a row the pointer rests on 150 ms has its detail read ahead, so its click paints from it.
  // The read is reused by the next load of that pull request for a short while; leaving the row cancels a pending read.
  const INTENT_DELAY_MS = 150;
  const PREFETCH_FRESH_MS = 30_000;
  const prefetched = new Map<string, { at: number; answer: Promise<unknown> }>();
  let intentTimer: ReturnType<typeof setTimeout> | undefined;
  const refKey = (ref: { projectId: string; host?: string; repository: string; number: number }) => JSON.stringify([ref.projectId, ref.host?.toLowerCase() ?? null, ref.repository.toLowerCase(), ref.number]);
  function intent(entry: PullRequestEntry | null) {
    clearTimeout(intentTimer);
    if (!entry) return;
    intentTimer = setTimeout(() => {
      if (deps.isListed && !deps.isListed(entry)) return;
      const ref = { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number };
      const key = refKey(ref);
      const cached = prefetched.get(key);
      if (cached && Date.now() - cached.at < PREFETCH_FRESH_MS) return;
      const answer = deps.request("pullRequests.detail", ref);
      answer.catch(() => { if (prefetched.get(key)?.answer === answer) prefetched.delete(key); });
      prefetched.set(key, { at: Date.now(), answer });
      if (prefetched.size > 50) prefetched.delete(prefetched.keys().next().value!);
    }, INTENT_DELAY_MS);
  }
  function readDetail(ref: { projectId: string; host?: string; repository: string; number: number }): Promise<unknown> {
    const key = refKey(ref);
    const cached = prefetched.get(key);
    prefetched.delete(key);
    return cached && Date.now() - cached.at < PREFETCH_FRESH_MS ? cached.answer : deps.request("pullRequests.detail", ref);
  }

  async function load() {
    const entry = deps.entry();
    const request = ++sequence;
    review.cancel();
    if (!entry) {
      detail.set(null); activity.set(null); status.set("idle");
      return;
    }
    status.set("loading");
    checksSettledEmpty.set(false);
    error.set("");
    notFound.set(false);
    activityError.set("");
    activity.set(null);
    const ref = { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number };
    // pullRequestStackView: a refresh of the same pull request keeps showing the stack it read (with a notice).
    const nextStackKey = JSON.stringify(ref);
    if (nextStackKey !== stackKey) stack.set(null);
    stackKey = nextStackKey;
    // readPullRequestDetailSnapshot: the last fresh read of this pull request paints at once while it is read again.
    let fromSnapshot = false;
    void readDetailSnapshot(ref).then((raw) => {
      if (raw === null || request !== sequence || status() !== "loading") return;
      try { detail.set(parseDetail(raw)); status.set("loaded"); fromSnapshot = true; } catch { /* an unreadable snapshot is ignored */ }
    });
    try {
      const raw = await readDetail(ref);
      const parsed = parseDetail(raw);
      if (request !== sequence) return;
      detail.set(parsed);
      detailAt = Date.now();
      checks = null;
      observeDetail(ref, parsed);
      status.set("loaded");
      writeDetailSnapshot(ref, raw);
      void refreshChecks();
    } catch (cause) {
      if (request !== sequence) return;
      if (!fromSnapshot) detail.set(null);
      error.set(cause instanceof Error ? cause.message : String(cause));
      notFound.set(cause instanceof RequestFailure && cause.reason === "not-found");
      if (!fromSnapshot) { status.set("error"); return; }
    }
    try {
      const parsed = parseActivity(await deps.request("pullRequests.activity", ref));
      if (request === sequence) activity.set(parsed);
    } catch (cause) {
      if (request === sequence) activityError.set(cause instanceof Error ? cause.message : String(cause));
    }
    if (detail()?.capabilities.stacks) {
      if (request === sequence) stackStatus.set("loading");
      try {
        const parsed = parseStack(await deps.request("pullRequests.stack", ref));
        if (request === sequence) { stack.set(parsed); stackStatus.set("loaded"); }
      } catch { if (request === sequence) stackStatus.set("error"); /* the stack itself is then not shown */ }
    } else if (request === sequence) stackStatus.set("idle");
  }

  /** Re-read detail and activity without blanking the panel, after a mutation. */
  async function refresh() {
    const entry = deps.entry();
    if (!entry) return;
    const request = sequence;
    const ref = { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number };
    try {
      const parsed = parseDetail(await deps.request("pullRequests.detail", ref));
      if (request === sequence) {
        // A newer checks answer still wins over the checks this detail read carried.
        detailAt = Date.now();
        detail.set(checks !== null && checks.at >= detailAt ? resolvePullRequestDetailChecks(parsed, checks.answer, true) : parsed);
        observeDetail(ref, parsed);
      }
    } catch (cause) {
      if (request === sequence) error.set(cause instanceof Error ? cause.message : String(cause));
    }
    try {
      const parsed = parseActivity(await deps.request("pullRequests.activity", ref));
      if (request === sequence) { activity.set(parsed); activityError.set(""); }
    } catch (cause) {
      // activityError = activity === null ? query.error : null: a refresh that fails keeps the activity shown, without the error state.
      if (request === sequence && activity() === null) activityError.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // ---- usePullRequestDetail checks (pullRequests.checks, gated on capabilities.pullRequestChecks) ----
  let detailAt = 0;
  let checks: { answer: PullRequestChecksAnswer<DetailCheck> | null; at: number } | null = null;
  /** A null answer is settled: polling cannot find checks. */
  const checksSettledEmpty = signal(false);
  const currentRef = () => {
    const entry = deps.entry();
    return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
  };
  function observeDetail(ref: DetailRef, parsed: PullRequestDetailData) {
    if (!deps.live) return;
    observePullRequestSummary(deps.live.environmentId(), ref, { ...parsed, isDraft: parsed.isDraft, checksState: pullRequestChecksState(parsed.checks) });
  }
  let checksInFlight = false;
  /** Bumped after every checks read so the poll re-arms at the cadence of what is now shown. */
  const checksTick = signal(0);
  async function refreshChecks() {
    const ref = currentRef();
    if (!deps.live || !ref || !deps.live.supportsChecks() || detail() === null || checksInFlight || status() === "loading") return;
    const request = sequence;
    checksInFlight = true;
    try {
      const raw = await deps.request("pullRequests.checks", ref);
      if (request !== sequence) return;
      const answer = raw === null ? null : parsePullRequestChecks(raw, parseDetailCheck);
      checks = { answer, at: Date.now() };
      checksSettledEmpty.set(raw === null);
      observePullRequestChecksAnswer(deps.live.environmentId(), ref, answer);
      const current = detail();
      if (current && answer) detail.set(resolvePullRequestDetailChecks(current, answer, checks.at >= detailAt));
    } catch { /* the detail's own checks stay */ } finally { checksInFlight = false; checksTick.update((value) => value + 1); }
  }
  // usePullRequestChecksRefresh: 45 s while checks run (or none are reported), 60 s once settled, while open.
  effect(() => {
    const current = detail();
    void checksTick();
    if (!deps.live || !current || current.state !== "open" || !deps.live.supportsChecks() || checksSettledEmpty()) return;
    const timer = setTimeout(() => void refreshChecks(), pullRequestChecksRefreshIntervalMs(current.checks));
    return () => clearTimeout(timer);
  });
  /** PullRequestDetailPanel refreshFromHost: pullRequests.invalidate { reference }, then read again. */
  const refreshing = signal(false);
  async function refreshFromHost() {
    const ref = currentRef();
    if (!ref) return;
    refreshing.set(true);
    try {
      await invalidatePullRequests(deps.request, { reference: ref });
      await refresh();
      await refreshChecks();
    } finally { refreshing.set(false); }
  }
  // refreshTrigger: detail, activity, checks and stack re-read when the environment pushes a refresh.
  if (deps.live) {
    const live = deps.live;
    usePullRequestRefreshes({
      environmentId: live.environmentId,
      connected: () => live.connected() && deps.entry() !== null,
      subscribe: live.subscribe,
      onRefresh: () => {
        if (!deps.entry() || status() === "loading") return;
        void refresh().then(() => refreshChecks());
        const ref = currentRef();
        if (ref && detail()?.capabilities.stacks) {
          const request = sequence;
          void deps.request("pullRequests.stack", ref).then((raw) => { if (request === sequence) stack.set(parseStack(raw)); }, () => {});
        }
      },
    });
  }

  const actions = createPullRequestActionsModel({
    request: deps.request,
    ref: () => {
      const entry = deps.entry();
      return entry ? { projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number } : null;
    },
    refresh,
    refreshFromHost,
    reviewerSearchable: () => detail()?.reviewerPicker.searchable === true,
    allowedMethods: () => (detail() ? allowedMergeMethods(detailActionable(detail()!)) : []),
    term: () => changeRequestTerm(detail()?.provider ?? deps.entry()?.provider ?? "github"),
    completionSupport: () => (detail() ? { mentions: detail()!.capabilities.mentions === true, referenceSigils: detail()!.capabilities.referenceSigils ?? [] } : null),
    ...(deps.onAction ? { onAction: deps.onAction } : {}),
  });

  effect(() => {
    const entry = deps.entry();
    if (entry) { tab.set(untracked(() => deps.rememberedTab?.read()) ?? "summary"); tabRestored = true; }
    void load();
    return () => { sequence++; };
  });

  return { refreshFromHost, refreshing, refreshChecks, request: deps.request, stack, stackStatus, guide, review, threadLinks, timelineOrder, actions, refresh, code, detail, activity, status, error, activityError, notFound, tab, reload: load, intent };
}

export type PullRequestDetailModel = ReturnType<typeof createPullRequestDetailModel>;
