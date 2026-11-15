// Grouping, filtering and ordering for the pull request list, ported from
// pullRequest/pullRequestList.logic.ts and pullRequestListGroups.logic.ts.
import type { PullRequestEntry } from "../../pages/utility-data";
import { projectViewerKey } from "./pullRequestMultiEnvironment";

export type ListState = "all" | "open" | "closed" | "merged";
export type Involvement = "all" | "reviewing" | "authored";
export type ListSort = "ready" | "blocked" | "updated" | "newest" | "oldest" | "largest" | "smallest";
export type GroupKey = "authored" | "reviewRequested" | "others";

export interface ListFilters {
  draft?: "only" | "hide";
  review?: "approved" | "changes-requested" | "review-required" | "none";
  checks?: "passing" | "failing";
  author?: string;
  labels?: string[];
  /** Typed `label:a,b` qualifiers: every group must match, any name within a group suffices. */
  labelGroups?: string[][];
  excludedLabels?: string[];
}

export interface PullRequestGroup {
  key: GroupKey;
  label: string;
  entries: PullRequestEntry[];
}

export const STATE_TABS: { value: ListState; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

export const INVOLVEMENT_TABS: { value: Involvement; label: string }[] = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Reviewing" },
  { value: "authored", label: "Authored" },
];

export const SORT_OPTIONS: { value: ListSort; label: string }[] = [
  { value: "ready", label: "Merge readiness" },
  { value: "blocked", label: "Blocked on me" },
  { value: "updated", label: "Recently updated" },
  { value: "newest", label: "Newest shown" },
  { value: "oldest", label: "Oldest shown" },
  { value: "largest", label: "Largest shown" },
  { value: "smallest", label: "Smallest shown" },
];

export const DRAFT_OPTIONS = [
  { value: "", label: "All" }, { value: "only", label: "Drafts only" }, { value: "hide", label: "Hide drafts" },
];
export const REVIEW_OPTIONS = [
  { value: "", label: "All" }, { value: "approved", label: "Approved" }, { value: "changes-requested", label: "Changes requested" },
  { value: "review-required", label: "Review required" }, { value: "none", label: "No reviews" },
];
export const CHECKS_OPTIONS = [
  { value: "", label: "All" }, { value: "passing", label: "Passing" }, { value: "failing", label: "Failing" },
];

const GROUP_LABELS: Record<GroupKey, string> = { reviewRequested: "Review requested", authored: "Authored", others: "Others" };

export function entryKey(entry: Pick<PullRequestEntry, "host" | "projectId" | "repository" | "number">): string {
  return `${entry.host}:${entry.projectId}:${entry.repository.toLowerCase()}:${entry.number}`;
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function timestamp(value: string): number | null {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function viewerOf(entry: PullRequestEntry, viewers: Record<string, string>): string | null {
  return normalize(viewers[projectViewerKey(entry.projectId, entry.host)] ?? viewers[entry.host]);
}

function isAuthoredByViewer(entry: PullRequestEntry, viewers: Record<string, string>): boolean {
  const viewer = viewerOf(entry, viewers);
  return viewer !== null && normalize(entry.author) === viewer;
}

export function matchesQuery(entry: PullRequestEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author}`.toLowerCase().includes(needle);
}

/** The text of a search with `label:` qualifiers moved out of it, as the web's parser does. */
export function parseSearch(raw: string): { text: string; labels: string[] } {
  const labels: string[] = [];
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/u)) {
    const match = /^label:(.+)$/iu.exec(word);
    if (match?.[1]) labels.push(match[1].replace(/^"|"$/gu, ""));
    else if (word) words.push(word);
  }
  return { text: words.join(" "), labels };
}

/**
 * `author:me` names whoever is signed in to the host being read, GitHub's `@me` spelled either way. The server resolves it
 * before it searches, so the rows are compared against the viewer's login rather than the literal "me"
 * (resolvePullRequestAuthorFilter in packages/contracts).
 */
export function resolveAuthorFilter(author: string, viewer: string | null | undefined): string {
  const trimmed = author.trim();
  if (!/^@?me$/iu.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}

/**
 * The rows that fit the filters, while the host's answer is pending and for the host that does not filter. A row's check
 * rollup can omit workflows awaiting approval, so the checks filter is left to the host (the web's
 * matchesPullRequestFilters has none either).
 */
export function matchesFilters(entry: PullRequestEntry, filters: ListFilters, viewer?: string | null): boolean {
  const labels = entry.labels.map((label) => label.name.trim().toLowerCase());
  const has = (name: string) => labels.includes(name.trim().toLowerCase());
  return (
    (filters.draft === undefined || entry.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined || (filters.review === "none" ? entry.reviewDecision === "" : entry.reviewDecision === filters.review)) &&
    (filters.labels === undefined || filters.labels.every(has)) &&
    (filters.labelGroups === undefined || filters.labelGroups.every((group) => group.some(has))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(has)) &&
    (filters.author === undefined || entry.author.toLowerCase() === resolveAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

export function filterByInvolvement(entries: PullRequestEntry[], viewers: Record<string, string>, involvement: Involvement): PullRequestEntry[] {
  if (involvement === "reviewing") return entries.filter((entry) => entry.viewerReviewRequested);
  if (involvement === "authored") return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  return entries;
}

export function compareByRecency(left: PullRequestEntry, right: PullRequestEntry): number {
  const leftUpdated = timestamp(left.updatedAt);
  const rightUpdated = timestamp(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

export function groupByInvolvement(entries: PullRequestEntry[], viewers: Record<string, string>): PullRequestGroup[] {
  const buckets: Record<GroupKey, PullRequestEntry[]> = { reviewRequested: [], authored: [], others: [] };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) buckets.authored.push(entry);
    else if (entry.viewerReviewRequested) buckets.reviewRequested.push(entry);
    else buckets.others.push(entry);
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

/** The rows the host answered for the authored and reviewing involvements, held beside the main list. */
export interface ListPartitions { authored: PullRequestEntry[]; reviewing: PullRequestEntry[] }

/**
 * partitionPullRequestsWithPriority: recency pagination can bring older priority rows into the main list, so the Authored and
 * Review requested groups are the hosts' own answers for those involvements (authored wins over reviewing), and the rest are
 * Others. Rows come from the main list when it holds them, so a fresher copy is shown.
 */
export function partitionWithPriority(entries: PullRequestEntry[], authored: PullRequestEntry[], reviewing: PullRequestEntry[]): PullRequestGroup[] {
  const authoredByKey = new Map(authored.map((entry) => [entryKey(entry), entry]));
  const reviewByKey = new Map(reviewing.flatMap((entry) => authoredByKey.has(entryKey(entry)) ? [] : [[entryKey(entry), entry] as const]));
  const others: PullRequestEntry[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (authoredByKey.has(key)) authoredByKey.set(key, entry);
    else if (reviewByKey.has(key)) reviewByKey.set(key, entry);
    else others.push(entry);
  }
  return ([
    { key: "authored" as const, entries: [...authoredByKey.values()].sort(compareByRecency) },
    { key: "reviewRequested" as const, entries: [...reviewByKey.values()].sort(compareByRecency) },
    { key: "others" as const, entries: others },
  ]).filter((group) => group.entries.length > 0).map((group) => ({ ...group, label: GROUP_LABELS[group.key] }));
}

const sized = (entry: PullRequestEntry) => entry.additions + entry.deletions;
const hasMeasuredSize = (entry: PullRequestEntry) => sized(entry) > 0;

/** Ready to merge first, then plain rows, drafts and unfinished ones, closed ones, and conflicts last; smaller before larger. */
export function rankByMergeReadiness(entries: PullRequestEntry[], measuredSize: (entry: PullRequestEntry) => boolean = hasMeasuredSize): PullRequestEntry[] {
  const tier = (entry: PullRequestEntry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return [...entries].sort((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const measured = Number(measuredSize(right)) - Number(measuredSize(left));
    return measured || sized(left) - sized(right) || compareByRecency(left, right);
  });
}

function rankByTierThenRecency(entries: PullRequestEntry[], tier: (entry: PullRequestEntry) => number): PullRequestEntry[] {
  return [...entries].sort((left, right) => {
    const byTier = tier(left) - tier(right);
    return byTier !== 0 ? byTier : compareByRecency(left, right);
  });
}

/** Rows the author has to act on first: conflicts, requested changes, failing checks, drafts; approved and passing last. */
export function rankBlockedOnAuthor(entries: PullRequestEntry[]): PullRequestEntry[] {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  });
}

function rankBlockedOnReviewer(entries: PullRequestEntry[]): PullRequestEntry[] {
  return rankByTierThenRecency(entries, (entry) => (entry.state === "open" ? 0 : 1));
}

export function sortGroups(groups: PullRequestGroup[], sort: ListSort, searchText: string, involvement: Involvement = "all", measuredSize: (entry: PullRequestEntry) => boolean = hasMeasuredSize): PullRequestGroup[] {
  const sortWithinGroups = (rank: (entries: PullRequestEntry[]) => PullRequestEntry[]) => groups.map((group) => ({ ...group, entries: rank(group.entries) }));
  if (sort === "ready") return searchText.trim().length === 0 ? sortWithinGroups((entries) => rankByMergeReadiness(entries, measuredSize)) : groups;
  if (sort === "blocked") {
    if (searchText.trim().length > 0) return groups;
    const role = (key: GroupKey): Involvement => (key === "others" ? involvement : key === "authored" ? "authored" : "reviewing");
    return groups.map((group) => {
      const groupRole = role(group.key);
      if (groupRole === "all") return group;
      return { ...group, entries: groupRole === "authored" ? rankBlockedOnAuthor(group.entries) : rankBlockedOnReviewer(group.entries) };
    });
  }
  if (sort === "updated") return groups;
  const stamp = (entry: PullRequestEntry) => timestamp(entry.updatedAt) ?? timestamp(entry.createdAt) ?? 0;
  return sortWithinGroups((entries) => [...entries].sort((left, right) => {
    if (sort === "newest" || sort === "oldest") {
      const leftCreated = timestamp(left.createdAt);
      const rightCreated = timestamp(right.createdAt);
      const measured = Number(rightCreated !== null) - Number(leftCreated !== null);
      const dated = (leftCreated ?? 0) - (rightCreated ?? 0);
      return measured || (sort === "newest" ? -dated : dated) || stamp(right) - stamp(left);
    }
    const measured = Number(measuredSize(right)) - Number(measuredSize(left));
    const delta = sized(left) - sized(right);
    return measured || (sort === "largest" ? -delta : delta) || stamp(right) - stamp(left);
  }));
}

export interface ListView { entries: PullRequestEntry[]; groups: PullRequestGroup[] }

/** The rows held, narrowed to what the reader asked for and arranged in the groups the list shows. */
export function buildListView(input: {
  entries: PullRequestEntry[];
  viewers: Record<string, string>;
  state: ListState;
  involvement: Involvement;
  filters: ListFilters;
  search: string;
  sort: ListSort;
  host?: string;
  /** Narrows the rows to one project (the list's project scope). */
  projectId?: string;
  /**
   * Hosts whose text search answered for this very query. A host search also covers bodies and commits that a row does not
   * show, so what it returned is not narrowed again here; text is matched locally only while the answer is pending or for a
   * host with no text search.
   */
  searchedHosts?: ReadonlySet<string>;
  /** The hosts' answers for the authored and reviewing involvements; used for the groups of an unsearched "all" list. */
  partitions?: ListPartitions;
  /** A zero-line diff can be measured even though it has no additions or deletions. */
  measuredSize?: (entry: PullRequestEntry) => boolean;
}): ListView {
  const parsed = effectiveFilters(input.filters, input.search);
  let rows = input.entries.filter((entry) =>
    (input.state === "all" || entry.state === input.state) && (input.host === undefined || entry.host === input.host) && (input.projectId === undefined || entry.projectId === input.projectId));
  rows = filterByInvolvement(rows, input.viewers, input.involvement).filter((entry) => matchesFilters(entry, parsed.filters, viewerOf(entry, input.viewers)));
  rows = parsed.text
    ? rows.filter((entry) => input.searchedHosts?.has(entry.host) === true || matchesQuery(entry, parsed.text))
    : [...rows].sort(compareByRecency);
  const narrow = (list: PullRequestEntry[]) => list
    .filter((entry) => (input.state === "all" || entry.state === input.state) && (input.host === undefined || entry.host === input.host) && (input.projectId === undefined || entry.projectId === input.projectId))
    .filter((entry) => matchesFilters(entry, parsed.filters, viewerOf(entry, input.viewers)));
  const groups = input.involvement !== "all"
    ? [{ key: "others" as const, label: "", entries: rows }]
    : input.partitions && !parsed.text
      ? partitionWithPriority(rows, narrow(input.partitions.authored), narrow(input.partitions.reviewing))
      : groupByInvolvement(rows, input.viewers);
  const sorted = sortGroups(groups, input.sort, parsed.text, input.involvement, input.measuredSize);
  return { entries: sorted.flatMap((group) => group.entries), groups: sorted };
}

export interface Facet { name: string; count: number }

export function collectFacets(entries: PullRequestEntry[]): { authors: Facet[]; labels: Facet[] } {
  const authors = new Map<string, Facet>();
  const labels = new Map<string, Facet>();
  for (const entry of entries) {
    if (entry.author) {
      const held = authors.get(entry.author.toLowerCase());
      authors.set(entry.author.toLowerCase(), { name: held?.name ?? entry.author, count: (held?.count ?? 0) + 1 });
    }
    for (const label of entry.labels) {
      const held = labels.get(label.name.toLowerCase());
      labels.set(label.name.toLowerCase(), { name: held?.name ?? label.name, count: (held?.count ?? 0) + 1 });
    }
  }
  const byCount = (a: Facet, b: Facet) => b.count - a.count || a.name.localeCompare(b.name);
  return { authors: [...authors.values()].sort(byCount), labels: [...labels.values()].sort(byCount) };
}

/** Rows from a later page replace the ones already held, then everything is deduplicated by key. */
export function mergeEntries(held: PullRequestEntry[], incoming: PullRequestEntry[]): PullRequestEntry[] {
  const merged = new Map<string, PullRequestEntry>();
  for (const entry of held) merged.set(entryKey(entry), entry);
  for (const entry of incoming) merged.set(entryKey(entry), entry);
  return [...merged.values()];
}

export function activeFilterCount(filters: ListFilters, state: ListState, involvement: Involvement, scope?: { host?: string; environmentId?: string; projectId?: string }): number {
  return (state !== "open" ? 1 : 0) + (involvement !== "all" ? 1 : 0) + (filters.draft ? 1 : 0) + (filters.review ? 1 : 0)
    + (filters.checks ? 1 : 0) + (filters.author ? 1 : 0) + (filters.labels?.length ?? 0)
    + (scope?.host ? 1 : 0) + (scope?.environmentId ? 1 : 0) + (scope?.projectId ? 1 : 0);
}

export function emptyStateKind(input: { hasProjects: boolean; query: string; filtered: boolean }): "no-projects" | "search" | "filtered" | "none" {
  if (!input.hasProjects) return "no-projects";
  if (input.query.trim().length > 0) return "search";
  return input.filtered ? "filtered" : "none";
}

// ---- The search box's qualifiers (packages/client-runtime pullRequestQuery.ts) ----

const REVIEW_VALUES: Record<string, NonNullable<ListFilters["review"]>> = {
  approved: "approved", changes_requested: "changes-requested", "changes-requested": "changes-requested",
  required: "review-required", "review-required": "review-required", none: "none",
};
const CHECKS_VALUES: Record<string, NonNullable<ListFilters["checks"]>> = { success: "passing", passing: "passing", failure: "failing", failing: "failing" };
const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/gu;
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;
const qualifierValue = (raw: string) => raw.replaceAll('"', "").trim();
const splitQualifierList = (raw: string) => (raw.match(/(?:[^,"]|"[^"]*")+/gu) ?? []).map(qualifierValue).filter((part) => part.length > 0);
const boundedNames = (names: readonly string[]) => names.slice(0, MAX_QUALIFIER_VALUES).map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim()).filter((name) => name.length > 0);

/**
 * The text of a search and the filters its qualifiers name: `label:` (a comma lists alternatives, `-label:` excludes),
 * `author:`, `draft:true|false`, `review:`, `status:` / `checks:`, and any other `scope:name` as a scoped label.
 */
export function parsePullRequestQuery(raw: string): { text: string; filters: ListFilters } {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: ListFilters["draft"];
  let review: ListFilters["review"];
  let checks: ListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/u.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names); else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (negated || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated ? undefined : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        if (!value.startsWith("/")) {
          const names = boundedNames(splitQualifierList(qualifier?.[3] ?? "").map((name) => (name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`)));
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names); else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0 ? {} : { labelGroups: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0 ? {} : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

/**
 * The menu's filters with the search box's qualifiers laid over them (the web's `{ ...menuFilters, ...typed.filters }`:
 * a typed qualifier replaces the menu's value, so a `label:` typed in the box outranks the label menu), and the free text left.
 */
export function effectiveFilters(menu: ListFilters, query: string): { text: string; filters: ListFilters } {
  const parsed = parsePullRequestQuery(query);
  const { labels: menuLabels, ...scalars } = menu;
  const menuGroups = menuLabels && menuLabels.length > 0 ? menuLabels.map((label) => [label]) : undefined;
  return { text: parsed.text, filters: { ...scalars, ...(menuGroups ? { labelGroups: menuGroups } : {}), ...parsed.filters } };
}

/** The request body for pullRequests.list: only the contract's fields. */
export function listRequest(input: { state: ListState; involvement: Involvement; filters: ListFilters; query: string; host?: string; projectId?: string; cursors?: Record<string, string>; limit: number }) {
  const parsed = effectiveFilters(input.filters, input.query);
  const f = parsed.filters;
  const filters = {
    ...(f.draft ? { draft: f.draft } : {}),
    ...(f.review ? { review: f.review } : {}),
    ...(f.checks ? { checks: f.checks } : {}),
    ...(f.author ? { author: f.author } : {}),
    ...(f.labelGroups && f.labelGroups.length > 0 ? { labels: f.labelGroups.slice(0, MAX_QUALIFIER_VALUES) } : {}),
    ...(f.excludedLabels && f.excludedLabels.length > 0 ? { excludedLabels: f.excludedLabels.slice(0, MAX_QUALIFIER_VALUES) } : {}),
  };
  return {
    state: input.state,
    involvement: input.involvement,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(parsed.text ? { query: parsed.text.slice(0, 200) } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.cursors && Object.keys(input.cursors).length > 0 ? { cursors: input.cursors } : {}),
    limit: input.limit,
  };
}

export type PullRequestQuickAction = "close" | "merge" | "ready" | "reopen";

/** pullRequestQuickActions: what the row's Shift-held group offers, limited to what the host takes. */
export function pullRequestQuickActions(entry: Pick<PullRequestEntry, "state" | "isDraft">, hostActions: ReadonlySet<string>): PullRequestQuickAction[] {
  const forState: PullRequestQuickAction[] = entry.state === "merged" ? [] : entry.state === "closed" ? ["reopen"] : entry.isDraft ? ["close", "ready"] : ["close", "merge"];
  return forState.filter((action) => hostActions.has(action));
}

/** scorePullRequestMatch: how well a listed entry matches the typed query (100 a number, 90 the title, ... 10 elsewhere). */
export function scorePullRequestMatch(entry: { number: number; title: string; headBranch: string; author: string; repository: string }, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;
  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if (entry.author.toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

/** The reference ranks host search results by match quality, with recency breaking ties. */
export function rankPullRequestMatches(entries: readonly PullRequestEntry[], query: string): PullRequestEntry[] {
  if (!query.trim()) return [...entries];
  return [...entries].sort((left, right) => scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query) || compareByRecency(left, right));
}

/** PullRequestListGroups' MATCHED_ELSEWHERE_SCORE: a row the host found by its description, not by what it shows. */
export const matchedElsewhere = (entry: Parameters<typeof scorePullRequestMatch>[0], query: string) => query.trim().length > 0 && scorePullRequestMatch(entry, query) <= 10;

// ---- Overrides after an action (pullRequestOverrideAfterAction / applyPullRequestOverrides / settlePullRequestOverrides) ----

export interface ListOverride { state: string; isDraft?: boolean; updatedAt: string; at: number }

/** PULL_REQUEST_OVERRIDE_TRUST_MS: an action's result is trusted over the host's listing for a minute, or until it agrees. */
export const PULL_REQUEST_OVERRIDE_TRUST_MS = 60_000;

export function overrideAfterAction(entry: { state: string; isDraft: boolean }, action: string, now: number): ListOverride | null {
  const stamp = { updatedAt: new Date(now).toISOString(), at: now };
  if (action === "close") return { state: "closed", ...stamp };
  if (action === "reopen") return { state: "open", ...stamp };
  if (action === "merge") return { state: "merged", ...stamp };
  if (action === "draft") return { state: entry.state, isDraft: true, ...stamp };
  if (action === "ready") return { state: entry.state, isDraft: false, ...stamp };
  return null;
}

export function applyOverrides<Entry extends { state: string; isDraft: boolean }>(entries: readonly Entry[], overrides: ReadonlyMap<string, ListOverride>, keyOf: (entry: Entry) => string): Entry[] {
  if (overrides.size === 0) return entries as Entry[];
  return entries.map((entry) => {
    const held = overrides.get(keyOf(entry));
    return held ? { ...entry, state: held.state, ...(held.isDraft === undefined ? {} : { isDraft: held.isDraft }), updatedAt: held.updatedAt } : entry;
  });
}

/** Retire overrides only when returned rows agree (or the minute is up); a row the answer left out proves nothing. */
export function settleOverrides<Entry extends { state: string; isDraft: boolean }>(overrides: ReadonlyMap<string, ListOverride>, answered: readonly Entry[], keyOf: (entry: Entry) => string, now: number): ReadonlyMap<string, ListOverride> {
  if (overrides.size === 0) return overrides;
  const byKey = new Map(answered.map((entry) => [keyOf(entry), entry]));
  const kept = new Map<string, ListOverride>();
  for (const [key, override] of overrides) {
    const row = byKey.get(key);
    if (row === undefined) { kept.set(key, override); continue; }
    const agrees = row.state === override.state && (override.isDraft === undefined || row.isDraft === override.isDraft);
    if (!agrees && now - override.at <= PULL_REQUEST_OVERRIDE_TRUST_MS) kept.set(key, override);
  }
  return kept.size === overrides.size ? overrides : kept;
}

/** MAX_PULL_REQUEST_STATS_REFS: one pullRequests.listStats request names at most 500 pull requests. */
export const MAX_PULL_REQUEST_STATS_REFS = 500;

const statKey = (row: { projectId: string; repository: string; number: number }) => `${row.projectId}\n${row.repository.toLowerCase()}\n${row.number}`;

/** pullRequestStatsBatches: rows whose listing carried no counts (GitHub listings omit them), 500 refs per request. */
export function pullRequestStatsBatches(entries: readonly { projectId: string; repository: string; number: number; additions: number; deletions: number }[], asked: ReadonlySet<string> = new Set()): { projectId: string; repository: string; number: number }[][] {
  const refs = entries
    .filter((entry) => entry.additions === 0 && entry.deletions === 0 && !asked.has(statKey(entry)))
    .map((entry) => ({ projectId: entry.projectId, repository: entry.repository, number: entry.number }));
  const batches: { projectId: string; repository: string; number: number }[][] = [];
  for (let index = 0; index < refs.length; index += MAX_PULL_REQUEST_STATS_REFS) batches.push(refs.slice(index, index + MAX_PULL_REQUEST_STATS_REFS));
  return batches;
}

export function pullRequestStatsKey(row: { projectId: string; repository: string; number: number }): string { return statKey(row); }

/** Keys with an actual stats response, including a measured zero-line diff. */
export function measuredPullRequestStats(answers: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const answer of answers) {
    const stats = answer && typeof answer === "object" && Array.isArray((answer as { stats?: unknown }).stats) ? (answer as { stats: unknown[] }).stats : [];
    for (const item of stats) {
      const stat = item as Record<string, unknown> | null;
      if (stat && typeof stat.projectId === "string" && typeof stat.repository === "string" && typeof stat.number === "number" && typeof stat.additions === "number" && typeof stat.deletions === "number") keys.add(statKey(stat as { projectId: string; repository: string; number: number }));
    }
  }
  return keys;
}

/** A pullRequests.listStats answer (PullRequestListStatsResult) folded into the rows it names. */
export function applyPullRequestStats<Entry extends { projectId: string; repository: string; number: number; additions: number; deletions: number }>(entries: readonly Entry[], answer: unknown): Entry[] {
  const stats = answer && typeof answer === "object" && Array.isArray((answer as { stats?: unknown }).stats) ? (answer as { stats: unknown[] }).stats : [];
  const byKey = new Map<string, { additions: number; deletions: number }>();
  for (const item of stats) {
    const stat = item as Record<string, unknown> | null;
    if (!stat || typeof stat.projectId !== "string" || typeof stat.repository !== "string" || typeof stat.number !== "number" || typeof stat.additions !== "number" || typeof stat.deletions !== "number") continue;
    byKey.set(statKey(stat as { projectId: string; repository: string; number: number }), { additions: stat.additions, deletions: stat.deletions });
  }
  if (byKey.size === 0) return [...entries];
  return entries.map((entry) => { const found = byKey.get(statKey(entry)); return found ? { ...entry, ...found } : entry; });
}
