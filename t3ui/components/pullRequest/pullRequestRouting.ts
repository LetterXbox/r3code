// client-runtime state/pullRequestRouting.ts: a pull request read or write the origin environment cannot serve with a
// verified account goes to another environment the user trusts (Settings > Connections > pull request routing) that
// has the same host account. With fewer than two environments every call goes straight to the origin, as there.
// Credentials stay on their environments; only a verified host and account cross the wire.

export type RoutingPermission = "off" | "read" | "read-write";
export interface RoutingEnvironment {
  id: string;
  enabled: boolean;
  /** An unsupported server (unsupportedReason) never routes. */
  supported: boolean;
  /** localhost / 127.0.0.1 / [::1]. */
  local: boolean;
  permission: RoutingPermission;
  /** Has a live session. */
  connected: boolean;
  /** environment.capabilities.pullRequestChecks. */
  supportsChecks: boolean;
}
export interface RoutingDeps {
  /** One request to one environment, unrouted. */
  request: (environmentId: string, tag: string, input: unknown) => Promise<unknown>;
  environments: () => readonly RoutingEnvironment[];
  setTimeout?: (run: () => void, ms: number) => unknown;
}
interface Ref { projectId: string; host?: string; repository: string; number: number; allowStale?: boolean; expectedAccountId?: string }
interface Identity { accountId: string; host: string; provider: string; viewer: string; projectTitle?: string; workspaceRoot?: string }

const reads = new Set([
  "pullRequests.summary", "pullRequests.stack", "pullRequests.detail", "pullRequests.preview", "pullRequests.checks",
  "pullRequests.activity", "pullRequests.threadComments", "pullRequests.diffFileContents", "pullRequests.filesViewed",
  "pullRequests.changeBreakdown", "pullRequests.reviewerCandidates", "pullRequests.labelCandidates",
]);
// Review guides are not routed: each server keeps its own.
const writes = new Set([
  "pullRequests.setFilesViewed", "pullRequests.runAction", "pullRequests.update", "pullRequests.comment",
  "pullRequests.updateComment", "pullRequests.submitReview", "pullRequests.replyToThread", "pullRequests.setReaction",
  "pullRequests.setThreadResolution", "pullRequests.requestReviewers", "pullRequests.setLabels",
]);
export const routedPullRequestMethods = new Set([...reads, ...writes, "pullRequests.invalidate"]);

const READ_TIMEOUT_MESSAGE = "The environment did not respond to the PR request.";

function isRef(value: unknown): value is Ref {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.projectId === "string" && typeof ref.repository === "string" && typeof ref.number === "number";
}
function hasState(value: unknown): value is { state: string; isDraft?: boolean } {
  return typeof value === "object" && value !== null && ["open", "closed", "merged"].includes((value as { state?: unknown }).state as string);
}
function isIdentity(value: unknown): value is Identity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.accountId === "string" && typeof identity.host === "string" && typeof identity.provider === "string";
}
function matchesReference(reference: Ref, filter: Ref): boolean {
  return reference.projectId === filter.projectId && reference.repository.toLowerCase() === filter.repository.toLowerCase()
    && reference.number === filter.number && (filter.host === undefined || reference.host?.toLowerCase() === filter.host.toLowerCase());
}
function rejectedBeforeDispatch(error: unknown): boolean {
  const tag = typeof error === "object" && error !== null ? (error as { tag?: unknown; _tag?: unknown }).tag ?? (error as { _tag?: unknown })._tag : undefined;
  return tag === "EnvironmentRpcUnavailableError" || tag === "EnvironmentNotRegisteredError" || (error instanceof Error && error.message === READ_TIMEOUT_MESSAGE);
}

export function createPullRequestRouter(deps: RoutingDeps) {
  const later = deps.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const within = <A>(promise: Promise<A>, ms: number, fallback: () => A | Promise<A>): Promise<A> => new Promise<A>((resolve, reject) => {
    let done = false;
    later(() => { if (!done) { done = true; Promise.resolve().then(fallback).then(resolve, reject); } }, ms);
    promise.then((value) => { if (!done) { done = true; resolve(value); } }, (error) => { if (!done) { done = true; reject(error); } });
  });
  const probe = <A>(promise: Promise<A>, ms: number): Promise<A | null> => within(promise.catch(() => null), ms, () => null);
  const readTimeout = <A>(promise: Promise<A>) => within(promise, 30_000, () => { throw new Error(READ_TIMEOUT_MESSAGE); });

  const routedReads = new Map<string, { origin: string; reference: Ref; targets: Set<string> }>();
  const pendingRouting = new Map<string, Promise<Identity | null>>();
  const pendingIdentities = new Map<string, Promise<Identity | null>>();
  const shared = (pending: Map<string, Promise<Identity | null>>, key: string, run: () => Promise<Identity | null>) => {
    const existing = pending.get(key);
    if (existing) return existing;
    const started = run().finally(() => pending.delete(key));
    pending.set(key, started);
    return started;
  };

  const entryOf = (id: string) => deps.environments().find((entry) => entry.id === id);
  function routingAllowed(originId: string, destinationId: string, write: boolean): boolean {
    const origin = entryOf(originId);
    const destination = entryOf(destinationId);
    if (!origin?.enabled || !destination?.enabled || !origin.supported || !destination.supported) return false;
    return write
      ? origin.permission === "read-write" && destination.permission === "read-write"
      : origin.permission !== "off" && destination.permission !== "off";
  }

  async function invalidateTarget(origin: string, target: string, inputs: readonly Record<string, unknown>[]) {
    if (target !== origin && !routingAllowed(origin, target, false)) return;
    // A stalled reader must not delay the write's answer.
    await Promise.all(inputs.map((input) => probe(deps.request(target, "pullRequests.invalidate", input), 1_000)));
  }

  /** The origin owns the threads linked to this pull request, but a routed read never reaches it. */
  function reportState(origin: string, { allowStale: _allowStale, expectedAccountId: _expected, ...reference }: Ref, status: { state: string; isDraft?: boolean }) {
    void probe(deps.request(origin, "pullRequests.reportState", { reference, state: status.state, ...(status.isDraft === undefined ? {} : { isDraft: status.isDraft }) }), 5_000);
  }

  async function routedRequest(origin: string, tag: string, input: unknown, sourceRead?: () => Promise<unknown>): Promise<unknown> {
    const source = sourceRead ?? (() => deps.request(origin, tag, input));
    if (tag === "pullRequests.invalidate" && typeof input === "object" && input !== null) {
      const invalidation = input as { reference?: Ref; filesViewedOnly?: boolean };
      const result = await deps.request(origin, tag, input);
      const targets = new Map<string, Ref>();
      for (const entry of routedReads.values()) {
        if (entry.origin !== origin) continue;
        if (invalidation.reference !== undefined && !matchesReference(entry.reference, invalidation.reference)) continue;
        for (const target of entry.targets) targets.set(target, entry.reference);
        if (invalidation.reference !== undefined) targets.set(origin, entry.reference);
      }
      await Promise.all([...targets].map(([target, reference]) => invalidateTarget(origin, target, [{ ...invalidation, ...(invalidation.reference === undefined ? {} : { reference }) }])));
      return result;
    }
    if ((!reads.has(tag) && !writes.has(tag)) || !isRef(input)) return deps.request(origin, tag, input);
    const ref = input;
    const write = writes.has(tag);
    const sourceEntry = entryOf(origin);
    const refKey = JSON.stringify([origin, ref.projectId, ref.host?.toLowerCase() ?? null, ref.repository.toLowerCase(), String(ref.number)]);
    const invalidateReaders = async () => {
      if (!write || routedReads.size === 0) return;
      const targets = new Map<string, Ref[]>([[origin, [ref]]]);
      for (const entry of routedReads.values()) {
        if (entry.origin !== origin || !matchesReference(entry.reference, ref)) continue;
        for (const target of [...entry.targets, origin]) {
          const refs = targets.get(target) ?? [];
          if (!refs.some((existing) => existing.host === entry.reference.host)) refs.push(entry.reference);
          targets.set(target, refs);
        }
      }
      const viewedOnly = tag === "pullRequests.setFilesViewed";
      await Promise.all([...targets].map(([target, refs]) => invalidateTarget(origin, target, [
        ...refs.map((reference) => ({ reference, ...(viewedOnly ? { filesViewedOnly: true } : {}) })),
        ...(viewedOnly ? [] : [{}]),
      ])));
    };
    // A failed viewed-files batch may have applied some paths. Other writes invalidate on success.
    const finish = async (operation: () => Promise<unknown>) => {
      if (tag === "pullRequests.setFilesViewed") {
        try { return await operation(); } finally { await invalidateReaders(); }
      }
      const result = await operation();
      await invalidateReaders();
      return result;
    };
    const alternatives: { id: string; local: boolean }[] = [];
    for (const entry of deps.environments()) {
      if (entry.id === origin || !routingAllowed(origin, entry.id, write) || !entry.connected) continue;
      if (tag === "pullRequests.checks" && !entry.supportsChecks) continue;
      alternatives.push({ id: entry.id, local: entry.local });
    }
    if (alternatives.length === 0) return finish(source);

    const identityProbe = () => probe(deps.request(origin, "pullRequests.routing", ref), 2_000).then((value) => (isIdentity(value) ? value : null));
    const identity = reads.has(tag)
      ? await shared(pendingRouting, JSON.stringify([origin, ref.projectId, ref.host?.toLowerCase() ?? null, ref.repository.toLowerCase()]), identityProbe)
      : await identityProbe();
    // The source server answers only for a host whose account it can verify.
    if (identity === null) return finish(source);

    const routedInput = { ...ref, host: identity.host, expectedAccountId: identity.accountId };
    let guarded: Promise<unknown> | null = null;
    const guardedSource = sourceRead ?? (() => (guarded ??= deps.request(origin, tag, routedInput)));
    const sourceLocal = sourceEntry?.local === true;
    const candidates = [
      ...(sourceLocal && write ? [origin] : []),
      ...alternatives.filter((entry) => entry.local).map((entry) => entry.id),
      ...(!sourceLocal && write ? [origin] : []),
      ...alternatives.filter((entry) => !entry.local).map((entry) => entry.id),
      ...(reads.has(tag) ? [origin] : []),
    ];
    const run = async (id: string) => {
      const result = id === origin ? await guardedSource() : await deps.request(id, tag, routedInput);
      if (id !== origin && hasState(result)) reportState(origin, ref, result);
      const entry = routedReads.get(refKey) ?? { origin, reference: { ...ref, host: identity.host }, targets: new Set<string>() };
      entry.targets.add(id);
      if (routedReads.size >= 256 && !routedReads.has(refKey)) {
        const oldest = routedReads.keys().next().value;
        if (oldest !== undefined) routedReads.delete(oldest);
      }
      routedReads.set(refKey, entry);
      return result;
    };
    const visit = async (index: number): Promise<unknown> => {
      const id = candidates[index];
      if (id === undefined) return guardedSource();
      if (id !== origin) {
        if (!routingAllowed(origin, id, write)) return visit(index + 1);
        // An older server would discard expectedAccountId. Verify it implements the guard first.
        const alternateProbe = () => probe(deps.request(id, "pullRequests.routingIdentity", { host: identity.host }), 2_000).then((value) => (isIdentity(value) ? value : null));
        const alternate = reads.has(tag) ? await shared(pendingIdentities, `${id}:${identity.host.toLowerCase()}`, alternateProbe) : await alternateProbe();
        if (alternate === null || alternate.provider !== identity.provider || alternate.host.toLowerCase() !== identity.host.toLowerCase() || alternate.accountId !== identity.accountId) {
          return visit(index + 1);
        }
        if (!routingAllowed(origin, id, write)) return visit(index + 1);
      }
      let result: unknown;
      try {
        result = reads.has(tag) ? await readTimeout(run(id)) : await run(id);
      } catch (error) {
        if ((reads.has(tag) || rejectedBeforeDispatch(error)) && index + 1 < candidates.length) return visit(index + 1);
        throw error;
      }
      return typeof result === "object" && result !== null && "projectId" in result
        ? { ...result, projectId: ref.projectId, ...(tag === "pullRequests.detail" ? { projectTitle: identity.projectTitle, workspaceRoot: identity.workspaceRoot } : {}) }
        : result;
    };
    return finish(() => visit(0));
  }

  /** PullRequestRouting.readOrWrite: what every pull request call goes through. */
  return async function readOrWrite(origin: string, tag: string, input: unknown): Promise<unknown> {
    if (!reads.has(tag) || !isRef(input)) return routedRequest(origin, tag, input);
    const entries = deps.environments();
    if (entries.length < 2) return deps.request(origin, tag, input);
    if (!entries.some((entry) => entry.id !== origin && routingAllowed(origin, entry.id, false))) return deps.request(origin, tag, input);
    const strictInput = { ...input, allowStale: false };
    let cached: Promise<unknown> | null = null;
    const source = () => (cached ??= readTimeout(deps.request(origin, tag, strictInput)));
    const routed = () => routedRequest(origin, tag, strictInput, source);
    try {
      return entryOf(origin)?.local === true ? await source().catch(() => routed()) : await routed();
    } catch (error) {
      if (input.allowStale !== false && (tag === "pullRequests.summary" || tag === "pullRequests.detail")) return deps.request(origin, tag, input);
      throw error;
    }
  };
}
