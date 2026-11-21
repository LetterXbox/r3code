// Issue state, multi-environment listing, detail cache, and mutations (#19259, #19274, #37760, #38854, #39351, #39536).
import { signal } from "nsh";
import { backendStatus, requestBackendUnrouted } from "../../store";
import { environmentConfigs, environmentConnections, managedEnvironmentIds, parseScopedKey, requestEnvironment } from "../../environments/connectionManager";
import { PRIMARY_ROUTING_ENVIRONMENT } from "../pullRequest/pullRequestRoutingInstall";
import { serverEnvironment, serverSettings } from "../../pages/settings/settingsState";
import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  mergeIssueEntries,
  parseIssueCandidates,
  parseIssueCommentsPage,
  parseIssueDetail,
  parseIssueLinkedThreads,
  parseIssueListResult,
  parseIssueTrackerConnections,
  replaceIssueTrackersSnapshot,
  threadIssueKeyOf,
  type EnvironmentIssueEntry,
  type HeldIssuePage,
  type IssueCandidates,
  type IssueDetail,
  type IssueInvolvement,
  type IssueLinkedThread,
  type IssueListEntry,
  type IssueListResult,
  type IssueListSort,
  type IssueListState,
  type IssueRef,
  type IssueScopeRef,
  type IssueState,
  type IssueTrackerGroup,
  type ThreadIssueLink,
} from "./issueLogic";

export type RequestFn = (method: string, payload: unknown) => Promise<unknown>;

function environmentCapabilities(environmentId?: string): Record<string, unknown> | null {
  if (!environmentId || environmentId === PRIMARY_ROUTING_ENVIRONMENT) {
    const env = serverEnvironment();
    const caps = env?.capabilities;
    return caps && typeof caps === "object" && !Array.isArray(caps) ? (caps as Record<string, unknown>) : null;
  }
  const env = environmentConfigs()[environmentId]?.environment as { capabilities?: Record<string, unknown> } | undefined;
  return env?.capabilities ?? null;
}

/** Whether at least one connected environment supports issue browsing (capabilities.issues). */
export function issuesSupported(environmentId?: string): boolean {
  if (environmentId) {
    const caps = environmentCapabilities(environmentId);
    if (caps && "issues" in caps) return caps.issues === true;
    return false;
  }
  const primaryCaps = environmentCapabilities(PRIMARY_ROUTING_ENVIRONMENT);
  if (primaryCaps && primaryCaps.issues === true) return true;
  if (primaryCaps === null && (serverEnvironment() !== null || serverSettings() !== null)) {
    // Some lightweight test fixtures provide serverEnvironment without capabilities; check secondary envs first.
  }
  for (const id of Object.keys(environmentConfigs())) {
    if (environmentCapabilities(id)?.issues === true) return true;
  }
  return false;
}

export function issueLinkedThreadsSupported(environmentId?: string): boolean {
  if (!environmentId || environmentId === PRIMARY_ROUTING_ENVIRONMENT) {
    const caps = environmentCapabilities(PRIMARY_ROUTING_ENVIRONMENT);
    return caps?.issueLinkedThreads === true;
  }
  return environmentCapabilities(environmentId)?.issueLinkedThreads === true;
}

export function resolveIssueEnvironmentId(projectId: string, explicitEnvId?: string): string {
  if (explicitEnvId) return explicitEnvId;
  const parsed = parseScopedKey(projectId);
  return parsed ? parsed.environmentId : PRIMARY_ROUTING_ENVIRONMENT;
}

function unscopePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.projectId === "string") {
    const parsed = parseScopedKey(payload.projectId);
    if (parsed) return { ...payload, projectId: parsed.localId };
  }
  return payload;
}

export async function requestIssueBackend(
  environmentId: string,
  method: string,
  payload: unknown,
  customRequest?: RequestFn,
): Promise<unknown> {
  if (customRequest) return await customRequest(method, payload);
  const rawObj = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const cleanPayload = environmentId === PRIMARY_ROUTING_ENVIRONMENT ? payload : unscopePayload(rawObj);
  if (environmentId === PRIMARY_ROUTING_ENVIRONMENT) return await requestBackendUnrouted(method, cleanPayload);
  return await requestEnvironment(environmentId, method, cleanPayload);
}

export function environmentLabel(environmentId: string): string | undefined {
  if (environmentId === PRIMARY_ROUTING_ENVIRONMENT) return undefined;
  const cfg = environmentConfigs()[environmentId];
  const title = (cfg?.environment as { label?: string; displayName?: string } | undefined)?.displayName
    ?? (cfg?.environment as { label?: string } | undefined)?.label;
  return typeof title === "string" && title.trim() ? title.trim() : environmentId;
}

/** Issues cache & actions across components (detail views, sidebar badges, markdown links). */
const detailCache = signal<Record<string, { detail: IssueDetail | null; loading: boolean; error: string | null }>>({});
const linkedThreadsCache = signal<Record<string, { threads: IssueLinkedThread[]; loading: boolean; error: string | null }>>({});
const inFlightDetails = new Map<string, Promise<IssueDetail | null>>();
const listInvalidationVersion = signal(0);

export function issueDetailCacheKey(environmentId: string, ref: Pick<IssueRef, "tracker" | "host" | "scope" | "key">): string {
  return `${environmentId}::${threadIssueKeyOf({
    tracker: ref.tracker,
    host: ref.host ?? "",
    scope: ref.scope,
    key: ref.key,
  })}`;
}

export function cachedIssueDetail(environmentId: string, ref: Pick<IssueRef, "tracker" | "host" | "scope" | "key">) {
  return detailCache()[issueDetailCacheKey(environmentId, ref)] ?? { detail: null, loading: false, error: null };
}

export function cachedIssueLinkedThreads(environmentId: string, ref: Pick<IssueRef, "tracker" | "host" | "scope" | "key">) {
  return linkedThreadsCache()[issueDetailCacheKey(environmentId, ref)] ?? { threads: [], loading: false, error: null };
}

export async function loadIssueDetail(
  environmentId: string,
  ref: IssueRef,
  options?: { force?: boolean; request?: RequestFn },
): Promise<IssueDetail | null> {
  const key = issueDetailCacheKey(environmentId, ref);
  const current = detailCache()[key];
  if (!options?.force && current?.detail) return current.detail;
  const pending = inFlightDetails.get(key);
  if (!options?.force && pending) return await pending;

  detailCache.update((all) => ({
    ...all,
    [key]: { detail: all[key]?.detail ?? null, loading: true, error: null },
  }));

  const task = (async (): Promise<IssueDetail | null> => {
    try {
      const raw = await requestIssueBackend(environmentId, "issues.detail", ref, options?.request);
      const parsed = parseIssueDetail(raw);
      detailCache.update((all) => ({
        ...all,
        [key]: { detail: parsed, loading: false, error: null },
      }));
      return parsed;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not load issue details.";
      detailCache.update((all) => ({
        ...all,
        [key]: { detail: all[key]?.detail ?? null, loading: false, error: message },
      }));
      return null;
    } finally {
      inFlightDetails.delete(key);
    }
  })();

  inFlightDetails.set(key, task);
  return await task;
}

export function patchCachedIssueDetail(
  environmentId: string,
  ref: Pick<IssueRef, "tracker" | "host" | "scope" | "key">,
  update: (detail: IssueDetail) => IssueDetail,
): void {
  const key = issueDetailCacheKey(environmentId, ref);
  detailCache.update((all) => {
    const slot = all[key];
    if (!slot?.detail) return all;
    return { ...all, [key]: { ...slot, detail: update(slot.detail) } };
  });
}

export async function loadOlderIssueComments(
  environmentId: string,
  ref: IssueRef,
  request?: RequestFn,
): Promise<boolean> {
  const key = issueDetailCacheKey(environmentId, ref);
  const current = detailCache()[key]?.detail;
  if (!current || !current.commentsCursor) return false;
  const raw = await requestIssueBackend(
    environmentId,
    "issues.comments",
    { ...ref, cursor: current.commentsCursor },
    request,
  );
  const page = parseIssueCommentsPage(raw);
  const seen = new Set(current.comments.map((c) => c.id));
  const merged = [...page.comments.filter((c) => !seen.has(c.id)), ...current.comments];
  detailCache.update((all) => {
    const slot = all[key];
    if (!slot?.detail) return all;
    return {
      ...all,
      [key]: {
        ...slot,
        detail: { ...slot.detail, comments: merged, commentsCursor: page.nextCursor },
      },
    };
  });
  return true;
}

export async function loadIssueCandidates(
  scopes: readonly (IssueScopeRef & { environmentId?: string })[],
  request?: RequestFn,
): Promise<IssueCandidates> {
  if (scopes.length === 0) return { labels: [], assignees: [], truncated: false };
  const labelMap = new Map<string, IssueCandidates["labels"][number]>();
  const assigneeMap = new Map<string, IssueCandidates["assignees"][number]>();
  let truncated = false;
  let lastError: unknown = null;
  let anySuccess = false;

  await Promise.all(
    scopes.map(async (scope) => {
      const envId = resolveIssueEnvironmentId(scope.projectId, scope.environmentId);
      try {
        const raw = await requestIssueBackend(
          envId,
          "issues.candidates",
          { projectId: scope.projectId, tracker: scope.tracker, ...(scope.host ? { host: scope.host } : {}), scope: scope.scope },
          request,
        );
        const parsed = parseIssueCandidates(raw);
        anySuccess = true;
        if (parsed.truncated) truncated = true;
        for (const label of parsed.labels) {
          const k = label.name.toLowerCase();
          if (!labelMap.has(k)) labelMap.set(k, label);
        }
        for (const assignee of parsed.assignees) {
          if (!assigneeMap.has(assignee.id)) assigneeMap.set(assignee.id, assignee);
        }
      } catch (err) {
        lastError = err;
      }
    }),
  );

  if (!anySuccess && lastError !== null) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return {
    labels: [...labelMap.values()],
    assignees: [...assigneeMap.values()],
    truncated,
  };
}

export async function loadIssueLinkedThreads(
  environmentId: string,
  ref: IssueRef & { host: string },
  request?: RequestFn,
): Promise<IssueLinkedThread[]> {
  const key = issueDetailCacheKey(environmentId, ref);
  linkedThreadsCache.update((all) => ({
    ...all,
    [key]: { threads: all[key]?.threads ?? [], loading: true, error: null },
  }));
  try {
    const raw = await requestIssueBackend(
      environmentId,
      "issues.linkedThreads",
      { tracker: ref.tracker, host: ref.host, scope: ref.scope, key: ref.key },
      request,
    );
    const threads = parseIssueLinkedThreads(raw);
    linkedThreadsCache.update((all) => ({
      ...all,
      [key]: { threads, loading: false, error: null },
    }));
    return threads;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not read linked threads.";
    linkedThreadsCache.update((all) => ({
      ...all,
      [key]: { threads: all[key]?.threads ?? [], loading: false, error: message },
    }));
    return [];
  }
}

export async function loadIssueTrackers(environmentId: string = PRIMARY_ROUTING_ENVIRONMENT, request?: RequestFn) {
  const raw = await requestIssueBackend(environmentId, "issueTrackers.list", {}, request);
  const parsed = parseIssueTrackerConnections(raw);
  replaceIssueTrackersSnapshot(environmentId, parsed);
  return parsed;
}

export function refreshIssueLists(): void {
  listInvalidationVersion.update((v) => v + 1);
}

export function issueListVersion(): number {
  return listInvalidationVersion();
}

export async function updateIssue(
  environmentId: string,
  input: IssueRef & { title?: string; body?: string; labels?: string[]; assignees?: string[] },
  request?: RequestFn,
): Promise<IssueDetail> {
  const raw = await requestIssueBackend(environmentId, "issues.update", input, request);
  const updated = parseIssueDetail(raw);
  const key = issueDetailCacheKey(environmentId, input);
  detailCache.update((all) => ({ ...all, [key]: { detail: updated, loading: false, error: null } }));
  refreshIssueLists();
  return updated;
}

export async function setIssueState(
  environmentId: string,
  input: IssueRef & { state: string },
  request?: RequestFn,
): Promise<IssueDetail> {
  const raw = await requestIssueBackend(environmentId, "issues.setState", input, request);
  const updated = parseIssueDetail(raw);
  const key = issueDetailCacheKey(environmentId, input);
  detailCache.update((all) => ({ ...all, [key]: { detail: updated, loading: false, error: null } }));
  refreshIssueLists();
  return updated;
}

export async function commentOnIssue(
  environmentId: string,
  input: IssueRef & { body: string },
  request?: RequestFn,
): Promise<IssueDetail> {
  const raw = await requestIssueBackend(environmentId, "issues.comment", input, request);
  const updated = parseIssueDetail(raw);
  const key = issueDetailCacheKey(environmentId, input);
  detailCache.update((all) => ({ ...all, [key]: { detail: updated, loading: false, error: null } }));
  refreshIssueLists();
  return updated;
}

export async function reactOnIssue(
  environmentId: string,
  input: IssueRef & { subjectId?: string; content: string; reacted: boolean },
  request?: RequestFn,
): Promise<void> {
  await requestIssueBackend(environmentId, "issues.react", input, request);
  await loadIssueDetail(environmentId, input, { force: true, request });
}

export async function createIssue(
  environmentId: string,
  input: { projectId: string; tracker: string; scope: string; title: string; body?: string; labels?: string[] },
  request?: RequestFn,
): Promise<IssueDetail> {
  const raw = await requestIssueBackend(environmentId, "issues.create", input, request);
  const created = parseIssueDetail(raw);
  const key = issueDetailCacheKey(environmentId, {
    tracker: created.tracker,
    host: created.host,
    scope: created.scope,
    key: created.key,
  });
  detailCache.update((all) => ({ ...all, [key]: { detail: created, loading: false, error: null } }));
  refreshIssueLists();
  return created;
}

/**
 * Aggregate sidebar state badge for linked issues (#39351):
 * open takes precedence over closed; if any linked issue isn't loaded yet, return null;
 * otherwise return closed (non-completed close reasons first).
 */
export function sidebarLinkedIssueState(
  environmentId: string,
  links: readonly ThreadIssueLink[] | undefined,
): IssueState | null {
  if (!links?.length || !issuesSupported(environmentId)) return null;
  const states: (IssueState | undefined)[] = [];
  for (const link of links) {
    const slot = cachedIssueDetail(environmentId, link);
    if (!slot.detail && !slot.loading && !slot.error) {
      void loadIssueDetail(environmentId, link);
    }
    states.push(slot.detail?.state);
  }
  const open = states.find((state) => state?.category === "open");
  if (open !== undefined) return open;
  if (states.includes(undefined)) return null;
  return states.find((state) => state?.closeReason && state.closeReason !== "completed") ?? states[0] ?? null;
}

export interface IssueListTargetInput {
  projectIds?: string[];
  host?: string;
  state: IssueListState;
  involvement: IssueInvolvement;
  sort?: IssueListSort;
  query?: string;
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueListTarget {
  environmentId: string;
  input: IssueListTargetInput;
}

export interface MultiEnvironmentIssueListModel {
  status: () => "idle" | "loading" | "ready" | "error";
  refreshing: () => boolean;
  loadingMore: () => boolean;
  view: () => IssueListResult;
  groups: () => IssueTrackerGroup[];
  entries: () => EnvironmentIssueEntry[];
  environmentErrors: () => Map<string, string>;
  error: () => string | null;
  load: (targets: readonly IssueListTarget[], mode?: "initial" | "manual" | "background") => Promise<void>;
  refresh: (mode?: "manual" | "background") => Promise<void>;
  retryFailed: () => Promise<void>;
  loadMore: (envIds?: readonly string[], host?: string) => Promise<void>;
  updateEntryState: (environmentId: string, ref: IssueRef, nextState: IssueState) => void;
}

/** Multi-environment issue list model with failed-only retry (#39536) and host-grouped pagination. */
export function createIssueListModel(deps?: { request?: RequestFn }): MultiEnvironmentIssueListModel {
  const statusSig = signal<"idle" | "loading" | "ready" | "error">("idle");
  const refreshingSig = signal(false);
  const loadingMoreSig = signal(false);
  const heldSig = signal<Map<string, HeldIssuePage>>(new Map());
  const failedEnvsSig = signal<Map<string, string>>(new Map());
  const sortSig = signal<IssueListSort>("updated");
  const querySig = signal("");
  let lastTargets: readonly IssueListTarget[] = [];
  let loadGeneration = 0;

  const emptyResult: IssueListResult = { viewers: {}, trackers: [], entries: [], errors: [], nextCursors: {}, scopes: [] };

  const viewSig = (): IssueListResult => {
    const held = heldSig();
    if (held.size === 0) return emptyResult;
    const viewers: Record<string, string> = {};
    const trackerMap = new Map<string, IssueListResult["trackers"][number]>();
    let entries: IssueListEntry[] = [];
    const errors: IssueListResult["errors"] = [];
    const nextCursors: Record<string, string> = {};
    const scopeMap = new Map<string, IssueScopeRef>();
    for (const page of held.values()) {
      Object.assign(viewers, page.answer.viewers);
      for (const tracker of page.answer.trackers) {
        const key = `${tracker.tracker}:${tracker.host}`;
        const prev = trackerMap.get(key);
        if (!prev || (!prev.configured && tracker.configured)) trackerMap.set(key, tracker);
      }
      entries = mergeIssueEntries(entries, page.entries);
      errors.push(...page.errors);
      Object.assign(nextCursors, page.nextCursors);
      for (const scope of page.answer.scopes ?? []) {
        scopeMap.set(`${scope.projectId}:${scope.tracker}:${scope.scope}`, scope);
      }
    }
    return {
      viewers,
      trackers: [...trackerMap.values()],
      entries,
      errors,
      nextCursors,
      scopes: [...scopeMap.values()],
    };
  };

  async function fetchTarget(target: IssueListTarget): Promise<IssueListResult> {
    const raw = await requestIssueBackend(target.environmentId, "issues.list", target.input, deps?.request);
    return parseIssueListResult(raw);
  }

  async function runTargets(targets: readonly IssueListTarget[], onlyFailed: boolean, mode: "initial" | "manual" | "background") {
    lastTargets = targets;
    sortSig.set(targets[0]?.input.sort ?? "updated");
    querySig.set(targets[0]?.input.query ?? "");
    const gen = ++loadGeneration;

    if (targets.length === 0) {
      heldSig.set(new Map());
      failedEnvsSig.set(new Map());
      statusSig.set("ready");
      refreshingSig.set(false);
      return;
    }

    const toFetch = onlyFailed
      ? targets.filter((t) => failedEnvsSig().has(t.environmentId))
      : targets;
    if (toFetch.length === 0) return;

    if (!onlyFailed && mode === "initial" && heldSig().size === 0) {
      statusSig.set("loading");
    } else {
      refreshingSig.set(true);
    }

    const nextHeld = new Map(heldSig());
    const nextErrors = new Map(failedEnvsSig());
    if (!onlyFailed) {
      for (const envId of nextHeld.keys()) {
        if (!targets.some((t) => t.environmentId === envId)) nextHeld.delete(envId);
      }
      for (const envId of nextErrors.keys()) {
        if (!targets.some((t) => t.environmentId === envId)) nextErrors.delete(envId);
      }
    }

    await Promise.all(
      toFetch.map(async (target) => {
        try {
          const result = await fetchTarget(target);
          if (gen !== loadGeneration) return;
          const updated = holdIssuePages([[target.environmentId, result]], nextHeld).get(target.environmentId);
          if (updated) nextHeld.set(target.environmentId, updated);
          nextErrors.delete(target.environmentId);
        } catch (cause) {
          if (gen !== loadGeneration) return;
          nextErrors.set(target.environmentId, cause instanceof Error ? cause.message : "Could not load issues.");
        }
      }),
    );

    if (gen !== loadGeneration) return;
    heldSig.set(nextHeld);
    failedEnvsSig.set(nextErrors);
    refreshingSig.set(false);
    statusSig.set(nextHeld.size === 0 && nextErrors.size > 0 ? "error" : "ready");
  }

  return {
    status: () => statusSig(),
    refreshing: () => refreshingSig(),
    loadingMore: () => loadingMoreSig(),
    view: viewSig,
    groups: () => groupIssues(heldSig(), querySig(), [], sortSig()),
    entries: () => {
      const out: EnvironmentIssueEntry[] = [];
      for (const [envId, page] of heldSig()) {
        for (const entry of page.entries) out.push({ ...entry, environmentId: envId });
      }
      return out;
    },
    environmentErrors: () => failedEnvsSig(),
    error: () => {
      const errs = [...failedEnvsSig().values()];
      return errs.length > 0 && heldSig().size === 0 ? errs[0]! : null;
    },
    load: (targets, mode = "initial") => runTargets(targets, false, mode),
    refresh: (mode = "manual") => runTargets(lastTargets, false, mode),
    retryFailed: () => runTargets(lastTargets, true, "manual"),
    loadMore: async (envIds, host) => {
      if (loadingMoreSig()) return;
      loadingMoreSig.set(true);
      try {
        const nextHeld = new Map(heldSig());
        const targetEnvs = envIds?.length ? envIds : [...nextHeld.keys()];
        await Promise.all(
          targetEnvs.map(async (envId) => {
            const page = nextHeld.get(envId);
            const target = lastTargets.find((t) => t.environmentId === envId);
            if (!page || !target) return;
            const cursors = host ? issueCursorsForHost(page.nextCursors, host) : page.nextCursors;
            if (Object.keys(cursors).length === 0) return;
            try {
              const raw = await requestIssueBackend(
                envId,
                "issues.list",
                { ...target.input, cursors },
                deps?.request,
              );
              nextHeld.set(envId, continueIssuePage(page, parseIssueListResult(raw), cursors));
            } catch (cause) {
              const msg = cause instanceof Error ? cause.message : "Could not load more issues.";
              nextHeld.set(envId, continueIssuePage(page, { failure: msg }, cursors));
            }
          }),
        );
        heldSig.set(nextHeld);
      } finally {
        loadingMoreSig.set(false);
      }
    },
    updateEntryState: (environmentId, ref, nextState) => {
      const nextHeld = new Map(heldSig());
      const page = nextHeld.get(environmentId);
      if (!page) return;
      const updatedEntries = page.entries.map((entry) =>
        entry.tracker === ref.tracker && entry.scope === ref.scope && entry.key === ref.key
          ? { ...entry, state: nextState }
          : entry,
      );
      nextHeld.set(environmentId, { ...page, entries: updatedEntries });
      heldSig.set(nextHeld);
    },
  };
}

/** Enumerates active connected environments when targeting all environments. */
export function activeIssueEnvironmentIds(): string[] {
  const out: string[] = [];
  if (backendStatus() === "connected" && issuesSupported(PRIMARY_ROUTING_ENVIRONMENT)) {
    out.push(PRIMARY_ROUTING_ENVIRONMENT);
  }
  for (const id of managedEnvironmentIds()) {
    if (environmentConnections()[id]?.phase === "connected" && issuesSupported(id)) {
      out.push(id);
    }
  }
  return out;
}
