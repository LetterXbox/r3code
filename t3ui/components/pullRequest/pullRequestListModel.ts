// The list's state and loading. `request` is injected so tests drive it without a server.
import { computed, effect, signal, Storage } from "nsh";
import { parsePullRequestPage, type PullRequestEntry, type PullRequestProvider } from "../../pages/utility-data";
import {
  applyOverrides, applyPullRequestStats, buildListView, compareByRecency, effectiveFilters, measuredPullRequestStats, pullRequestStatsBatches, pullRequestStatsKey, collectFacets, emptyStateKind, entryKey, listRequest, mergeEntries, overrideAfterAction, rankPullRequestMatches, settleOverrides, type ListOverride,
  type Involvement, type ListFilters, type ListPartitions, type ListSort, type ListState,
} from "./pullRequestList.logic";
import {
  PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY, readPullRequestListPreferences, writePullRequestListPreferences, type PullRequestListPreferences,
} from "./pullRequestListPreferences";
import type { PullRequestEnvironmentTarget } from "./pullRequestMultiEnvironment";
import { readPullRequestSnapshot, writePullRequestSnapshot } from "./pullRequestSnapshot";

export type LoadStatus = "idle" | "loading" | "loaded" | "error";

export interface ListModelDeps {
  /** Where the saved choices are kept; the app's storage by default. Reads resolve before the first load. */
  preferences?: { read: () => Promise<string | null>; write: (raw: string) => Promise<void> };
  request: (method: string, payload: unknown) => Promise<unknown>;
  connected: () => boolean;
  hasProjects: () => boolean;
  /** The projects the project scope can name; a saved scope for one that is gone is dropped once these are known. */
  projects?: () => { id: string; title: string }[];
  debounceMs?: number;
  /** Identifies the current connection and credentials for the in-memory list cache. */
  cacheNamespace?: () => string;
  now?: () => number;
  environments?: () => readonly PullRequestEnvironmentTarget[];
  environmentForProject?: (projectId: string) => string;
  multiEnvironment?: {
    list: (payload: unknown, environmentId?: string) => Promise<unknown>;
    retry?: (payload: unknown, environmentId?: string) => Promise<unknown>;
    stats: (payload: unknown) => Promise<unknown>;
    filterOptions: (payload: unknown, environmentId?: string) => Promise<unknown>;
  };
}

/** PullRequestsPage.tsx PAGE_SIZE. */
export const PAGE_SIZE = 99;
export const MAX_PAGE_SIZE = 500;

const LIST_CACHE_TTL_MS = 5 * 60_000;
const listCache = new Map<string, { storedAt: number; page: ReturnType<typeof parsePullRequestPage> }>();

export function createPullRequestListModel(deps: ListModelDeps) {
  const now = deps.now ?? Date.now;
  const state = signal<ListState>("open");
  const involvement = signal<Involvement>("all");
  const sort = signal<ListSort>("ready");
  const filters = signal<ListFilters>({});
  const search = signal("");
  const host = signal<string | undefined>(undefined);
  /** The saved project scope. It stays as saved until the projects are known (resolveProjectScope), then only if the project exists. */
  const savedProjectId = signal<string | undefined>(undefined);
  const environmentId = signal<string | undefined>(undefined);
  const projectId = (): string | undefined => {
    const wanted = savedProjectId();
    const known = deps.projects?.() ?? [];
    return wanted === undefined || known.length === 0 ? wanted : known.some((project) => project.id === wanted) ? wanted : undefined;
  };
  /** False until the saved choices were read, so the first load asks for the restored list rather than the default one. */
  const restored = signal(false);
  /** The text the server was last asked about: it follows `search` after a pause, or at once on Enter. */
  const sentQuery = signal("");
  /** The text the rows held answer (set when a load completes). */
  const answeredQuery = signal<string | null>(null);

  const answeredEntries = signal<PullRequestEntry[]>([]);
  const statsAnswers = signal<unknown[]>([]);
  const withStats = (rows: PullRequestEntry[]) => statsAnswers().reduce<PullRequestEntry[]>((current, answer) => applyPullRequestStats(current, answer), rows);
  /** What an action just did, shown over the host's listing until it agrees or a minute passes (settleOverrides). */
  const overrides = signal<ReadonlyMap<string, ListOverride>>(new Map());
  const entries = Object.assign(() => applyOverrides(withStats(answeredEntries()), overrides(), entryKey), {
    set: (next: PullRequestEntry[]) => { answeredEntries.set(next); overrides.set(settleOverrides(overrides(), next, entryKey, Date.now())); },
  });
  /** An action on a listed pull request finished (a quick action, the detail's close/reopen/merge/ready/draft). */
  function recordAction(entry: { projectId: string; host: string; repository: string; number: number; state: string; isDraft: boolean }, action: string) {
    const override = overrideAfterAction(entry, action, Date.now());
    if (override) overrides.set(new Map(overrides()).set(entryKey(entry as PullRequestEntry), override));
  }
  const viewers = signal<Record<string, string>>({});
  const providers = signal<PullRequestProvider[]>([]);
  const errors = signal<string[]>([]);
  const cursors = signal<Record<string, string>>({});
  const truncated = signal(false);
  const status = signal<LoadStatus>("idle");
  const error = signal("");
  const loadingMore = signal(false);
  /** The hosts' own answers for the authored and reviewing involvements: only asked for an unsearched "all" list that has rows. */
  const partitions = signal<ListPartitions | null>(null);
  let sequence = 0;
  let partitionSequence = 0;
  let lastListScope: string | null = null;

  async function loadPartitions(request: number, body: ReturnType<typeof listRequest>) {
    const partitionRequest = ++partitionSequence;
    // The main list goes first: it proves the list has rows, so an empty one does not cost two more reads.
    const ask = async (involvement: Involvement) => { const payload = { ...body, involvement, limit: PAGE_SIZE, cursors: undefined }; return parsePullRequestPage(await (deps.multiEnvironment ? deps.multiEnvironment.list(payload, environmentId()) : deps.request("pullRequests.list", payload))).entries; };
    try {
      const [authored, reviewing] = await Promise.all([ask("authored"), ask("reviewing")]);
      if (request === sequence && partitionRequest === partitionSequence) { partitions.set({ authored, reviewing }); void loadStats(); }
    } catch {
      // The groups fall back to the viewer's own login and the rows' review requests.
      if (request === sequence && partitionRequest === partitionSequence) partitions.set(null);
    }
  }

  // pullRequestStatsRequestBatches (eager policy): rows listed without counts ask pullRequests.listStats, 500 refs a request.
  const statsAsked = new Set<string>();
  let statsEpoch = 0;
  async function loadStats() {
    const groups = partitions();
    const rows = withStats([...answeredEntries(), ...(groups?.authored ?? []), ...(groups?.reviewing ?? [])]);
    const seen = new Set(statsAsked);
    const unique = rows.filter((row) => { const key = pullRequestStatsKey(row); if (seen.has(key)) return false; seen.add(key); return true; });
    for (const refs of pullRequestStatsBatches(unique, statsAsked)) {
      const epoch = statsEpoch;
      for (const ref of refs) statsAsked.add(pullRequestStatsKey(ref));
      try {
        const answer = await (deps.multiEnvironment ? deps.multiEnvironment.stats({ refs }) : deps.request("pullRequests.listStats", { refs }));
        if (epoch !== statsEpoch) return;
        const failedProjects = answer && typeof answer === "object" && "failedProjects" in answer && Array.isArray(answer.failedProjects) ? new Set(answer.failedProjects) : null;
        if (failedProjects) for (const ref of refs) if (failedProjects.has(ref.projectId)) statsAsked.delete(pullRequestStatsKey(ref));
        statsAnswers.set([...statsAnswers(), answer]);
      } catch {
        if (epoch === statsEpoch) for (const ref of refs) statsAsked.delete(pullRequestStatsKey(ref));
      }
    }
  }
  async function load(append = false, retryFailedOnly = false) {
    const request = ++sequence;
    if (!deps.connected()) {
      status.set("idle");
      entries.set([]);
      return;
    }
    const scope = JSON.stringify([environmentId() ?? null, projectId() ?? null]);
    if (scope !== lastListScope) {
      lastListScope = scope;
      statsEpoch++; statsAsked.clear(); statsAnswers.set([]); entries.set([]); partitions.set(null); viewers.set({}); cursors.set({});
    }
    if (append) loadingMore.set(true);
    else {
      status.set("loading");
      error.set("");
    }
    try {
      const asked = sentQuery();
      const body = listRequest({
        state: state(), involvement: involvement(), filters: filters(), query: asked, host: host(), ...(projectId() ? { projectId: projectId() as string } : {}),
        ...(append ? { cursors: cursors() } : {}), limit: PAGE_SIZE,
      });
      const namespace = deps.cacheNamespace?.();
      const cacheKey = namespace ? JSON.stringify([namespace, environmentId(), body]) : null;
      const held = !append && entries().length === 0 && cacheKey ? listCache.get(cacheKey) : undefined;
      const cached = held && now() - held.storedAt < LIST_CACHE_TTL_MS ? held : undefined;
      let freshAnswer = false;
      if (!append && asked === "" && cacheKey && !cached && entries().length === 0) {
        void readPullRequestSnapshot(cacheKey).then((snapshot) => {
          if (!snapshot || freshAnswer || request !== sequence || entries().length > 0) return;
          entries.set(snapshot.entries);
          viewers.set(snapshot.viewers);
          providers.set(snapshot.providers);
          errors.set([]);
          cursors.set({});
          truncated.set(snapshot.truncated);
          answeredQuery.set(asked);
          if (status() !== "error") status.set("loaded");
          void loadStats();
          if (involvement() === "all" && snapshot.entries.length > 0) void loadPartitions(request, body);
        });
      }
      if (cached) {
        entries.set(rankPullRequestMatches(cached.page.entries, effectiveFilters(filters(), asked).text));
        viewers.set(cached.page.viewers);
        providers.set(cached.page.providers);
        errors.set(cached.page.errors);
        cursors.set(cached.page.nextCursors);
        truncated.set(cached.page.truncated);
        answeredQuery.set(asked);
        status.set("loaded");
        void loadStats();
        // Restore the authored/review groups independently of the main refresh.
        // Otherwise a slow refresh leaves cached rows in the fallback groups.
        if (involvement() === "all" && asked === "" && cached.page.entries.length > 0) void loadPartitions(request, body);
      }
      const listCall = deps.multiEnvironment
        ? (retryFailedOnly && deps.multiEnvironment.retry
          ? deps.multiEnvironment.retry(body, environmentId())
          : deps.multiEnvironment.list(body, environmentId()))
        : deps.request("pullRequests.list", body);
      const answer = await listCall;
      const page = parsePullRequestPage(answer);
      if (request !== sequence) return;
      freshAnswer = true;
      // A partial server failure must not replace a complete saved snapshot.
      if (!append && asked === "" && cacheKey && page.errors.length === 0) void writePullRequestSnapshot(cacheKey, answer);
      if (!append && cacheKey && page.errors.length === 0) {
        listCache.delete(cacheKey);
        listCache.set(cacheKey, { storedAt: now(), page });
        if (listCache.size > 20) listCache.delete(listCache.keys().next().value!);
      }
      const text = effectiveFilters(filters(), asked).text;
      const arrived = rankPullRequestMatches(append ? [...page.entries].sort(compareByRecency) : page.entries, text);
      entries.set(append ? mergeEntries(entries(), arrived, deps.multiEnvironment ? deps.environmentForProject : undefined) : arrived);
      viewers.set({ ...(append ? viewers() : {}), ...page.viewers });
      providers.set(page.providers);
      errors.set(append ? [...new Set([...errors(), ...page.errors])] : page.errors);
      cursors.set(page.nextCursors);
      void loadStats();
      truncated.set(page.truncated);
      answeredQuery.set(asked);
      status.set("loaded");
      if (!append) {
        if (involvement() === "all" && asked === "" && page.entries.length > 0) void loadPartitions(request, body);
        else partitions.set(null);
      }
    } catch (cause) {
      if (request !== sequence) return;
      error.set(cause instanceof Error ? cause.message : String(cause));
      status.set("error");
    } finally {
      if (request === sequence) loadingMore.set(false);
    }
  }

  // Typing is sent after a pause so it does not make a request per key; Enter sends it at once (submitSearch).
  effect(() => {
    const typed = search();
    const timer = setTimeout(() => sentQuery.set(typed.trim()), deps.debounceMs ?? 250);
    return () => clearTimeout(timer);
  });

  // Any change to what is asked for reloads.
  effect(() => {
    const connected = deps.connected();
    state(); involvement(); filters(); sentQuery(); host(); projectId(); environmentId(); deps.environments?.();
    if (!restored()) return;
    const timer = setTimeout(() => {
      if (connected) void load();
      else { sequence++; statsEpoch++; statsAsked.clear(); statsAnswers.set([]); entries.set([]); errors.set([]); error.set(""); answeredQuery.set(null); status.set("idle"); }
    }, 0);
    return () => { clearTimeout(timer); sequence++; };
  });

  // ---- Saved choices ----
  const store = deps.preferences ?? {
    read: () => Storage.getItem(PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY),
    write: (raw: string) => Storage.setItem(PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY, raw),
  };
  const preferences = (): PullRequestListPreferences => {
    const menu = filters();
    return {
      involvement: involvement(), state: state(), sort: sort(), ...(environmentId() ? { environmentId: environmentId() as string } : {}), ...(projectId() ? { projectId: projectId() as string } : {}), ...(host() ? { host: host() as string } : {}), ...(sentQuery() ? { q: sentQuery() } : {}),
      ...(menu.draft ? { draft: menu.draft } : {}), ...(menu.review ? { review: menu.review } : {}), ...(menu.checks ? { checks: menu.checks } : {}),
      ...(menu.author ? { author: menu.author } : {}), ...(menu.labels && menu.labels.length > 0 ? { labels: menu.labels } : {}),
    };
  };
  void store.read().catch(() => null).then((raw) => {
    const saved = readPullRequestListPreferences(raw);
    state.set(saved.state); involvement.set(saved.involvement);
    if (saved.sort) sort.set(saved.sort);
    if (saved.host) host.set(saved.host);
    if (saved.environmentId) environmentId.set(saved.environmentId);
    if (saved.projectId) savedProjectId.set(saved.projectId);
    if (saved.q) { search.set(saved.q); sentQuery.set(saved.q); }
    filters.set({
      ...(saved.draft ? { draft: saved.draft } : {}), ...(saved.review ? { review: saved.review } : {}), ...(saved.checks ? { checks: saved.checks } : {}),
      ...(saved.author ? { author: saved.author } : {}), ...(saved.labels ? { labels: saved.labels } : {}),
    });
    restored.set(true);
  });
  effect(() => {
    const next = writePullRequestListPreferences(preferences());
    if (restored()) void store.write(next).catch(() => undefined);
  });

  /** Hosts that search their own text and have answered for the text now typed: their rows are not narrowed again here. */
  const searchedHosts = computed(() => (status() === "loaded" && answeredQuery() === search().trim()
    ? new Set(providers().filter((provider) => provider.searchesOnHost).map((provider) => provider.host))
    : new Set<string>()));

  const view = computed(() => {
    const measured = measuredPullRequestStats(statsAnswers());
    return buildListView({
      entries: entries(), viewers: viewers(), state: state(), involvement: involvement(), filters: filters(),
      search: search(), sort: sort(), host: host(), ...(projectId() ? { projectId: projectId() as string } : {}), searchedHosts: searchedHosts(), ...(partitions() ? { partitions: { authored: withStats((partitions() as ListPartitions).authored), reviewing: withStats((partitions() as ListPartitions).reviewing) } } : {}),
      measuredSize: (entry) => entry.additions + entry.deletions > 0 || measured.has(pullRequestStatsKey(entry)),
    });
  });
  const facets = computed(() => collectFacets(entries()));
  const filtered = () => state() !== "open" || involvement() !== "all" || host() !== undefined || projectId() !== undefined || environmentId() !== undefined
    || Object.values(filters()).some((value) => value !== undefined);
  const emptyKind = () => emptyStateKind({ hasProjects: deps.hasProjects(), query: search(), filtered: filtered() });
  const hasMore = () => Object.keys(cursors()).length > 0;

  /** pullRequests.filterOptions (useHostedFilterOptions): the host's authors or labels for a typed query, scoped like the list. */
  async function searchFilterOptions(kind: "authors" | "labels", query: string): Promise<string[]> {
    const typed = query.trim().slice(0, 100);
    const input = { kind, ...(projectId() ? { projectId: projectId() } : {}), ...(host() ? { host: host() } : {}), ...(typed ? { query: typed } : {}) };
    const value = await (deps.multiEnvironment ? deps.multiEnvironment.filterOptions(input, environmentId()) : deps.request("pullRequests.filterOptions", input)) as { authors?: unknown; labels?: unknown } | null;
    const list = (kind === "authors" ? value?.authors : value?.labels);
    return Array.isArray(list) ? list.flatMap((entry) => {
      const item = entry as Record<string, unknown> | null;
      const name = kind === "authors" ? item?.login : item?.name;
      return typeof name === "string" && name ? [name] : [];
    }) : [];
  }

  return {
    searchFilterOptions,
    recordAction,
    state, involvement, sort, filters, search, host, environmentId,
    /** The project the list is scoped to (undefined: all projects). */
    projectId, setProjectId(next: string | undefined) { savedProjectId.set(next); if (next && deps.environmentForProject) environmentId.set(deps.environmentForProject(next)); },
    setEnvironmentId(next: string | undefined) { environmentId.set(next); savedProjectId.set(undefined); },
    environments: () => deps.environments?.() ?? [],
    projects: () => (deps.projects?.() ?? []).filter((project) => !environmentId() || !deps.environmentForProject || deps.environmentForProject(project.id) === environmentId()),
    entries, viewers, providers, errors, cursors, truncated, status, error, loadingMore,
    view, partitions, facets, filtered, emptyKind, hasMore, sentQuery, searchedHosts,
    /** Enter in the search box: ask the server for the typed text now. */
    submitSearch() { sentQuery.set(search().trim()); },
    load, refresh: () => load(false), retry: () => load(false, true), loadMore: () => load(true),
    preferences,
    applyPreferences(next: PullRequestListPreferences) {
      involvement.set(next.involvement);
      state.set(next.state);
      sort.set(next.sort ?? "ready");
      environmentId.set(next.environmentId);
      savedProjectId.set(next.projectId);
      host.set(next.host);
      search.set(next.q ?? "");
      sentQuery.set(next.q ?? "");
      filters.set({
        ...(next.draft ? { draft: next.draft } : {}),
        ...(next.review ? { review: next.review } : {}),
        ...(next.checks ? { checks: next.checks } : {}),
        ...(next.author ? { author: next.author } : {}),
        ...(next.labels ? { labels: next.labels } : {}),
      });
    },
    setFilter<K extends keyof ListFilters>(key: K, value: ListFilters[K] | undefined) {
      filters.update((current) => {
        const next = { ...current };
        if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
        else next[key] = value as ListFilters[K];
        return next;
      });
    },
    clearFilters() {
      filters.set({});
    },
  };
}

export type PullRequestListModel = ReturnType<typeof createPullRequestListModel>;
