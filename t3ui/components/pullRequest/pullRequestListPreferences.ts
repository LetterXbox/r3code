// The list's saved choices (pullRequestListPreferences.ts): the state and involvement tabs, the sort, the menu
// filters and the typed search survive a restart. The web keeps them in localStorage under this key; here the
// app's storage holds them.
import type { Involvement, ListFilters, ListSort, ListState } from "./pullRequestList.logic";

export const PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY = "t3.pullRequests.preferences";

export interface PullRequestListPreferences {
  involvement: Involvement;
  state: ListState;
  /** The server (environment) and project the list is scoped to, as the web's route search carries them. */
  environmentId?: string;
  projectId?: string;
  host?: string;
  q?: string;
  draft?: NonNullable<ListFilters["draft"]>;
  review?: NonNullable<ListFilters["review"]>;
  checks?: NonNullable<ListFilters["checks"]>;
  author?: string;
  labels?: string[];
  sort?: ListSort;
}

export const DEFAULT_PULL_REQUEST_LIST_PREFERENCES: PullRequestListPreferences = { involvement: "all", state: "open" };

const INVOLVEMENTS: readonly string[] = ["all", "reviewing", "authored"];
const STATES: readonly string[] = ["all", "open", "closed", "merged"];
const SORTS: readonly string[] = ["ready", "blocked", "updated", "newest", "oldest", "largest", "smallest"];
const DRAFTS: readonly string[] = ["only", "hide"];
const REVIEWS: readonly string[] = ["approved", "changes-requested", "review-required", "none"];
const CHECKS: readonly string[] = ["passing", "failing"];
const MAX_TEXT = 200;
const MAX_LABELS = 10;

const bounded = (value: unknown): string | undefined => (typeof value === "string" && value.length <= MAX_TEXT ? value : undefined);

/** Only what the list can restore, and nothing it would send as its default (sort "ready"). */
export function normalizePreferences(input: PullRequestListPreferences): PullRequestListPreferences {
  return {
    involvement: input.involvement,
    state: input.state,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.draft ? { draft: input.draft } : {}),
    ...(input.review ? { review: input.review } : {}),
    ...(input.checks ? { checks: input.checks } : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    ...(input.sort && input.sort !== "ready" ? { sort: input.sort } : {}),
  };
}

/** Reads saved text; anything that does not decode (or is out of bounds) is the defaults, never a half-restored list. */
export function readPullRequestListPreferences(raw: string | null | undefined): PullRequestListPreferences {
  if (!raw) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    if (!INVOLVEMENTS.includes(value.involvement as string) || !STATES.includes(value.state as string)) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    const optional = <T extends string>(key: string, allowed: readonly string[]): T | undefined => (value[key] === undefined ? undefined : allowed.includes(value[key] as string) ? (value[key] as T) : undefined);
    for (const key of ["environmentId", "projectId", "host", "q", "author"]) if (value[key] !== undefined && bounded(value[key]) === undefined) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length > MAX_LABELS || value.labels.some((label) => bounded(label) === undefined))) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    for (const [key, allowed] of [["draft", DRAFTS], ["review", REVIEWS], ["checks", CHECKS], ["sort", SORTS]] as const) {
      if (value[key] !== undefined && !allowed.includes(value[key] as string)) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    }
    return normalizePreferences({
      involvement: value.involvement as Involvement,
      state: value.state as ListState,
      ...(bounded(value.environmentId) ? { environmentId: bounded(value.environmentId) as string } : {}),
      ...(bounded(value.projectId) ? { projectId: bounded(value.projectId) as string } : {}),
      ...(bounded(value.host) ? { host: bounded(value.host) as string } : {}),
      ...(bounded(value.q) ? { q: bounded(value.q) as string } : {}),
      ...(optional<NonNullable<ListFilters["draft"]>>("draft", DRAFTS) ? { draft: optional<NonNullable<ListFilters["draft"]>>("draft", DRAFTS) as NonNullable<ListFilters["draft"]> } : {}),
      ...(optional<NonNullable<ListFilters["review"]>>("review", REVIEWS) ? { review: optional<NonNullable<ListFilters["review"]>>("review", REVIEWS) as NonNullable<ListFilters["review"]> } : {}),
      ...(optional<NonNullable<ListFilters["checks"]>>("checks", CHECKS) ? { checks: optional<NonNullable<ListFilters["checks"]>>("checks", CHECKS) as NonNullable<ListFilters["checks"]> } : {}),
      ...(bounded(value.author) ? { author: bounded(value.author) as string } : {}),
      ...(Array.isArray(value.labels) ? { labels: value.labels as string[] } : {}),
      ...(optional<ListSort>("sort", SORTS) ? { sort: optional<ListSort>("sort", SORTS) as ListSort } : {}),
    });
  } catch {
    return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  }
}

export const writePullRequestListPreferences = (preferences: PullRequestListPreferences): string => JSON.stringify(normalizePreferences(preferences));
