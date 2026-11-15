// The pull request state layer: client-runtime state/pullRequests.ts (refresh stream, checks, linked summary,
// invalidate), apps/web state/pullRequests.ts (the shared observations a list, detail, checks and summary answer
// feed, with their merge rules), client-runtime pullRequestChecks.ts and useThreadLinkedPullRequest.ts (relink).
// Everything takes its transport as a parameter so tests drive it without a server.
import { effect, signal, untracked, type Signal } from "nsh";
import { pullRequestChecksState } from "./pullRequestDetail.logic";

export type Request = (method: string, payload: unknown) => Promise<unknown>;
export type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
export interface PullRequestRef { projectId: string; host?: string; repository: string; number: number; allowStale?: boolean; expectedAccountId?: string }

// ---- Summaries and their merge rules (apps/web state/pullRequests.ts:44-197) ----

export interface PullRequestSummary {
  state: string;
  updatedAt: string;
  observedAt?: number;
  isDraft?: boolean;
  mergeability?: unknown;
  reviewDecision?: unknown;
  checksState?: string | null;
  title?: string;
  [key: string]: unknown;
}
export interface ObservedPullRequestSummary { summary: PullRequestSummary; observedAt: number }
export interface ObservedPullRequestChecks { checksState: string | null; readAt: number | undefined; observedAt: number }
export interface PullRequestObservations { metadata: ObservedPullRequestSummary | null; checks: ObservedPullRequestChecks | null }

function compareSummaries(current: PullRequestSummary, incoming: PullRequestSummary): number {
  const merged = Number(incoming.state === "merged") - Number(current.state === "merged");
  if (merged !== 0) return merged;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated;
  if (current.observedAt === undefined && incoming.observedAt === undefined) return 0;
  return (incoming.observedAt ?? -Infinity) - (current.observedAt ?? -Infinity);
}

export function newestPullRequestSummary(current: PullRequestSummary | null, observed: PullRequestSummary | null): PullRequestSummary | null {
  if (current === null) return observed;
  if (observed === null) return current;
  return compareSummaries(current, observed) >= 0 ? observed : current;
}

export function newestPullRequestObservation(current: ObservedPullRequestSummary | null, incoming: ObservedPullRequestSummary | null): ObservedPullRequestSummary | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  let order = compareSummaries(current.summary, incoming.summary);
  if (order === 0 && current.summary.observedAt === undefined && incoming.summary.observedAt === undefined) {
    order = incoming.observedAt - current.observedAt;
  }
  if (!(order > 0)) return current;
  // A sparse summary must not erase known status, or carry old detail stats into a new list read.
  return {
    ...incoming,
    summary: {
      ...incoming.summary,
      isDraft: incoming.summary.isDraft ?? current.summary.isDraft,
      mergeability: incoming.summary.mergeability ?? current.summary.mergeability,
      reviewDecision: incoming.summary.reviewDecision === undefined ? current.summary.reviewDecision : incoming.summary.reviewDecision,
      checksState: incoming.summary.checksState === undefined ? current.summary.checksState : incoming.summary.checksState,
    },
  };
}

export function observePullRequestChecks(current: PullRequestObservations, incoming: ObservedPullRequestChecks): PullRequestObservations {
  const previous = current.checks;
  const newer = previous === null
    || (previous.readAt !== undefined && incoming.readAt !== undefined ? incoming.readAt >= previous.readAt : incoming.observedAt >= previous.observedAt);
  return newer ? { ...current, checks: incoming } : current;
}

export function observePullRequestMetadata(current: PullRequestObservations, incoming: ObservedPullRequestSummary): PullRequestObservations {
  const metadata = newestPullRequestObservation(current.metadata, incoming);
  const next = metadata === current.metadata ? current : { ...current, metadata };
  const { checksState } = incoming.summary;
  return checksState === undefined ? next : observePullRequestChecks(next, { checksState, readAt: incoming.summary.observedAt, observedAt: incoming.observedAt });
}

export function observedPullRequestSummary(observations: PullRequestObservations): PullRequestSummary | null {
  const { metadata, checks } = observations;
  if (metadata === null) return null;
  return checks === null ? metadata.summary : { ...metadata.summary, checksState: checks.checksState };
}

// Project ids pin the remote host; host is left out so legacy, URL and list references share entries.
export function pullRequestSummaryKey(environmentId: string, reference: { projectId: string; repository: string; number: number }): string {
  return JSON.stringify([environmentId, reference.projectId, reference.repository.toLowerCase(), reference.number]);
}

const noObservations: PullRequestObservations = { metadata: null, checks: null };
const observations = signal<Record<string, PullRequestObservations>>({});

function record(key: string, observe: (current: PullRequestObservations) => PullRequestObservations) {
  const all = untracked(() => observations());
  const previous = all[key] ?? noObservations;
  const next = observe(previous);
  if (next !== previous) observations.set({ ...all, [key]: next });
}

/** Where every list, detail and summary answer lands (the reference's onAnswer handlers). */
export function observePullRequestSummary(environmentId: string, reference: { projectId: string; repository: string; number: number }, summary: PullRequestSummary, observedAt = Date.now()) {
  record(pullRequestSummaryKey(environmentId, reference), (current) => observePullRequestMetadata(current, { summary, observedAt }));
}

/** The checks answer: its own freshness, so it never carries old metadata forward. */
export function observePullRequestChecksAnswer(environmentId: string, reference: { projectId: string; repository: string; number: number }, checks: { observedAt?: number; checks: readonly { status: string }[] } | null, observedAt = Date.now()) {
  if (checks === null) return;
  record(pullRequestSummaryKey(environmentId, reference), (current) => observePullRequestChecks(current, { checksState: pullRequestChecksState(checks.checks), readAt: checks.observedAt, observedAt }));
}

/** useSharedPullRequestSummary: the newest of every answer and the thread's saved link. */
export function sharedPullRequestSummary(environmentId: string | null, reference: { projectId: string; repository: string; number: number } | null, saved: PullRequestSummary | null = null): PullRequestSummary | null {
  const current = environmentId === null || reference === null ? noObservations : observations()[pullRequestSummaryKey(environmentId, reference)] ?? noObservations;
  return newestPullRequestSummary(observedPullRequestSummary(current), saved);
}

export function resetPullRequestObservationsForTest() { observations.set({}); }

// ---- Checks (client-runtime pullRequestChecks.ts) ----

export interface PullRequestChecksAnswer<Check> { observedAt?: number; state: string; checks: Check[] }

export function parsePullRequestChecks<Check>(value: unknown, parseCheck: (raw: unknown) => Check | null): PullRequestChecksAnswer<Check> | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string") return null;
  return {
    ...(typeof raw.observedAt === "number" ? { observedAt: raw.observedAt } : {}),
    state: raw.state,
    checks: Array.isArray(raw.checks) ? raw.checks.flatMap((check) => { const parsed = parseCheck(check); return parsed === null ? [] : [parsed]; }) : [],
  };
}

export function resolvePullRequestDetailChecks<Detail extends { state: string; checks: Check[]; observedAt?: number | undefined }, Check>(detail: Detail | null, checks: PullRequestChecksAnswer<Check> | null, checksAreNewer: boolean): Detail | null {
  if (detail === null || checks === null) return detail;
  const newer = detail.observedAt !== undefined && checks.observedAt !== undefined ? checks.observedAt >= detail.observedAt : checksAreNewer;
  return newer ? { ...detail, state: detail.state === "merged" ? "merged" : checks.state, checks: checks.checks } : detail;
}

/** Checks still running are worth a tighter poll than a settled head. */
export function pullRequestChecksRefreshIntervalMs(checks: readonly { status?: unknown }[]): number {
  return checks.length === 0 || checks.some((check) => check.status === "pending" || check.status === "action-required") ? 45_000 : 60_000;
}

// ---- The refresh stream (pullRequests.subscribeRefreshes, one per environment) ----

interface RefreshStream { users: number; stop: (() => void) | null; tick: Signal<number> }
const streams = new Map<string, RefreshStream>();

function streamFor(environmentId: string): RefreshStream {
  let stream = streams.get(environmentId);
  if (!stream) { stream = { users: 0, stop: null, tick: signal(0) }; streams.set(environmentId, stream); }
  return stream;
}

/** Holds the environment's one refresh subscription open while anything reads it. */
export function retainPullRequestRefreshes(environmentId: string, subscribe: Subscribe): () => void {
  const stream = streamFor(environmentId);
  stream.users += 1;
  if (stream.stop === null) {
    // A transport that fails at once (no connection) calls back before it returns.
    let ended = false;
    let stop: (() => void) | null = null;
    stop = subscribe("pullRequests.subscribeRefreshes", {}, () => { stream.tick.update((tick) => tick + 1); }, () => {
      // The stream ended (a disconnect): the next retain after reconnecting opens a new one.
      ended = true;
      if (stop !== null && stream.stop === stop) stream.stop = null;
    });
    if (!ended) stream.stop = stop;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stream.users -= 1;
    if (stream.users > 0 || stream.stop === null) return;
    const stop = stream.stop;
    stream.stop = null;
    stop();
  };
}

/** Every revision the server has pushed for the environment (the reference's refreshes atom). */
export const pullRequestRefreshTick = (environmentId: string) => streamFor(environmentId).tick();

/**
 * refreshTrigger: a mounted read re-runs when the environment pushes a refresh after it was read. Call inside a
 * component; `connected` gates the subscription so a reconnect opens a fresh one.
 */
export function usePullRequestRefreshes(input: { environmentId: () => string; connected: () => boolean; subscribe: Subscribe; onRefresh: () => void }) {
  effect(() => {
    if (!input.connected()) return;
    const environmentId = input.environmentId();
    return untracked(() => retainPullRequestRefreshes(environmentId, input.subscribe));
  });
  let readUnder: { environmentId: string; tick: number } | null = null;
  effect(() => {
    const environmentId = input.environmentId();
    const tick = pullRequestRefreshTick(environmentId);
    const changed = readUnder !== null && readUnder.environmentId === environmentId && readUnder.tick !== tick;
    readUnder = { environmentId, tick };
    if (changed) untracked(() => input.onRefresh());
  });
}

export function resetPullRequestRefreshesForTest() {
  for (const stream of streams.values()) stream.stop?.();
  streams.clear();
}

// ---- Invalidate (pullRequests.invalidate: only a person's refresh spends host requests) ----

/** PullRequestsPage refreshFromHost ({}) and PullRequestDetailPanel refreshFromHost ({ reference }). Settles without throwing. */
export async function invalidatePullRequests(request: Request, input: { reference?: PullRequestRef; filesViewedOnly?: boolean }): Promise<void> {
  try {
    await request("pullRequests.invalidate", input.reference === undefined ? input : { ...input, reference: pullRequestReference(input.reference) });
  } catch { /* reportFailure: false, the following read still runs */ }
}

export function pullRequestReference(ref: PullRequestRef): PullRequestRef {
  return {
    projectId: ref.projectId,
    ...(ref.host === undefined ? {} : { host: ref.host }),
    repository: ref.repository,
    number: ref.number,
    ...(ref.allowStale === undefined ? {} : { allowStale: ref.allowStale }),
    ...(ref.expectedAccountId === undefined ? {} : { expectedAccountId: ref.expectedAccountId }),
  };
}

// ---- Linked summary (createLinkedPullRequestSummaryAtomFamily: pullRequests.summary) ----

export const LINKED_PULL_REQUEST_STALE_MS = 60_000;
export const LINKED_PULL_REQUEST_REFRESH_MS = 60_000;
const summaryReads = new Map<string, { at: number; answer: Promise<PullRequestSummary | null> }>();

/** One shared read per pull request for 60 s; its answer lands in the observations. */
export function readLinkedPullRequestSummary(request: Request, environmentId: string, reference: PullRequestRef, now = Date.now()): Promise<PullRequestSummary | null> {
  const key = pullRequestSummaryKey(environmentId, reference);
  const cached = summaryReads.get(key);
  if (cached && now - cached.at < LINKED_PULL_REQUEST_STALE_MS) return cached.answer;
  const answer = request("pullRequests.summary", pullRequestReference(reference)).then((value) => {
    const summary = value && typeof value === "object" && typeof (value as PullRequestSummary).state === "string" ? value as PullRequestSummary : null;
    if (summary) observePullRequestSummary(environmentId, reference, summary);
    return summary;
  });
  answer.catch(() => summaryReads.delete(key));
  summaryReads.set(key, { at: now, answer });
  return answer;
}

/** Mounted for its answers: re-read every 60 s and on each refresh push until merged (isFinal). */
export function useLinkedPullRequestSummary(input: { environmentId: () => string; reference: () => PullRequestRef | null; connected: () => boolean; request: Request; subscribe: Subscribe }) {
  const read = (force: boolean) => {
    const reference = untracked(() => input.reference());
    if (!reference || !untracked(() => input.connected())) return;
    const environmentId = untracked(() => input.environmentId());
    if (force) summaryReads.delete(pullRequestSummaryKey(environmentId, reference));
    void readLinkedPullRequestSummary(input.request, environmentId, reference).catch(() => {});
  };
  const final = () => {
    const reference = input.reference();
    return reference !== null && sharedPullRequestSummary(input.environmentId(), reference)?.state === "merged";
  };
  effect(() => {
    const key = input.reference() ? JSON.stringify(pullRequestReference(input.reference()!)) : null;
    if (!key || !input.connected()) return;
    untracked(() => read(false));
    if (untracked(final)) return;
    const timer = setInterval(() => { if (!final()) read(true); }, LINKED_PULL_REQUEST_REFRESH_MS);
    return () => clearInterval(timer);
  });
  usePullRequestRefreshes({ environmentId: input.environmentId, connected: () => input.connected() && input.reference() !== null, subscribe: input.subscribe, onRefresh: () => { if (!final()) read(true); } });
}

export function resetLinkedPullRequestSummariesForTest() { summaryReads.clear(); }

// ---- Thread linked pull request relink (useThreadLinkedPullRequest.ts) ----

export interface ThreadLinkedPullRequest { projectId: string; repository: string; number: number; url: string }

/** The newer open request on the thread's branch that replaces a merged or closed linked one, else null. */
export function threadLinkedPullRequestReplacement(input: {
  persisted: ThreadLinkedPullRequest | null;
  persistedState: string | null;
  projectId: string | null;
  projectRepository: string | null;
  threadBranch: string | null;
  gitStatus: { refName: string | null; pr: { number: number; url: string; state: string; headRef?: string | null } | null } | null;
}): ThreadLinkedPullRequest | null {
  const { persisted, persistedState, projectId, projectRepository, threadBranch, gitStatus } = input;
  const detected = gitStatus?.pr;
  return persisted === null
    || (persistedState !== "merged" && persistedState !== "closed")
    || gitStatus?.refName !== threadBranch
    || detected?.state !== "open"
    || detected.headRef !== threadBranch
    || projectId === null
    || projectRepository === null
    || (persisted.projectId === projectId && persisted.repository.toLowerCase() === projectRepository.toLowerCase() && persisted.number === detected.number)
    ? null
    : { projectId, repository: projectRepository, number: detected.number, url: detected.url };
}

/**
 * Persists the replacement once per change (thread.metadata.update linkedPullRequest), retargets an open panel on the
 * replaced request, and toasts "Unable to update the thread pull request" when the write fails.
 */
export function createThreadLinkedPullRequestRelinker(deps: {
  updateMetadata: (input: { threadId: string; linkedPullRequest: ThreadLinkedPullRequest }) => Promise<unknown>;
  openSurface: (threadId: string) => { kind: string; projectId?: string; repository?: string; number?: number } | null;
  openPullRequest: (threadId: string, target: ThreadLinkedPullRequest) => void;
  toast: (input: { type: "error"; title: string; description: string }) => void;
}) {
  const relinkKeys = new Map<string, string>();
  let write: Promise<void> = Promise.resolve();
  return function step(threadId: string | null, persisted: ThreadLinkedPullRequest | null, replacement: ThreadLinkedPullRequest | null): Promise<void> {
    if (threadId === null) return write;
    if (replacement === null) { relinkKeys.delete(threadId); return write; }
    const relinkKey = `${replacement.projectId}:${replacement.repository}#${replacement.number}`;
    if (relinkKeys.get(threadId) === relinkKey) return write;
    relinkKeys.set(threadId, relinkKey);
    const surface = deps.openSurface(threadId);
    if (surface?.kind === "pull-request" && persisted !== null && surface.projectId === persisted.projectId
      && surface.repository?.toLowerCase() === persisted.repository.toLowerCase() && surface.number === persisted.number) {
      deps.openPullRequest(threadId, replacement);
    }
    write = write.then(async () => {
      if (relinkKeys.get(threadId) !== relinkKey) return;
      try {
        await deps.updateMetadata({ threadId, linkedPullRequest: replacement });
      } catch (error) {
        if (relinkKeys.get(threadId) !== relinkKey) return;
        relinkKeys.delete(threadId);
        deps.toast({ type: "error", title: "Unable to update the thread pull request", description: error instanceof Error ? error.message : "An error occurred." });
      }
    });
    return write;
  };
}
