// Persistent issue list preferences and named saved views (#37963, #38256, #38799).
import { signal, Storage } from "nsh";
import type { IssueInvolvement, IssueListSort, IssueListState } from "./issueLogic";

export const ISSUE_LIST_PREFERENCES_STORAGE_KEY = "t3.issues.preferences";
export const ISSUE_SAVED_VIEWS_KEY = "t3.issues.savedViews";
export const ISSUE_VIEW_NAME_MAX_LENGTH = 80;

export interface IssueListPreferences {
  who: IssueInvolvement;
  status: IssueListState;
  hideProjects?: [string, string][];
  host?: string;
  q?: string;
  label?: string[];
  assignee?: string;
  order?: IssueListSort;
}

export const DEFAULT_ISSUE_LIST_PREFERENCES: IssueListPreferences = { who: "all", status: "open" };

const WHOS: readonly string[] = ["all", "assigned", "authored", "mentioned"];
const STATUSES: readonly string[] = ["all", "open", "closed"];
const ORDERS: readonly string[] = ["updated", "created"];
const bounded = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v.length <= 200 ? v.trim() : undefined);

export function normalizeIssuePreferences(input: IssueListPreferences): IssueListPreferences {
  return {
    who: input.who,
    status: input.status,
    ...(input.hideProjects?.length ? { hideProjects: input.hideProjects.slice(0, 1000) } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.label?.length ? { label: input.label.slice(0, 20) } : {}),
    ...(input.assignee ? { assignee: input.assignee } : {}),
    ...(input.order === "created" ? { order: "created" } : {}),
  };
}

export function readIssueListPreferences(raw: string | null | undefined): IssueListPreferences {
  if (!raw) return DEFAULT_ISSUE_LIST_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ISSUE_LIST_PREFERENCES;
    if (!WHOS.includes(String(value.who)) || !STATUSES.includes(String(value.status))) return DEFAULT_ISSUE_LIST_PREFERENCES;
    const hideProjects = Array.isArray(value.hideProjects)
      ? value.hideProjects.flatMap((pair): [string, string][] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" ? [[pair[0], pair[1]]] : [])
      : undefined;
    const labels = Array.isArray(value.label) ? value.label.filter((l): l is string => bounded(l) !== undefined) : undefined;
    return normalizeIssuePreferences({
      who: value.who as IssueInvolvement,
      status: value.status as IssueListState,
      ...(hideProjects?.length ? { hideProjects } : {}),
      ...(bounded(value.host) ? { host: bounded(value.host) } : {}),
      ...(bounded(value.q) ? { q: bounded(value.q) } : {}),
      ...(labels?.length ? { label: labels } : {}),
      ...(bounded(value.assignee) ? { assignee: bounded(value.assignee) } : {}),
      ...(ORDERS.includes(String(value.order)) && value.order === "created" ? { order: "created" } : {}),
    });
  } catch {
    return DEFAULT_ISSUE_LIST_PREFERENCES;
  }
}

export interface IssueSavedView {
  id: string;
  name: string;
  preferences: IssueListPreferences;
}

export function issueViewMatches(view: IssueSavedView, preferences: IssueListPreferences): boolean {
  const key = (value: IssueListPreferences) => {
    const normalized = normalizeIssuePreferences(value);
    return JSON.stringify({
      ...normalized,
      label: normalized.label ? [...normalized.label].sort() : undefined,
      hideProjects: normalized.hideProjects ? normalized.hideProjects.map((p) => JSON.stringify(p)).sort() : undefined,
    });
  };
  return key(view.preferences) === key(preferences);
}

export function issueViewNameError(name: string, views: readonly IssueSavedView[], editingId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for this view.";
  if (trimmed.length > ISSUE_VIEW_NAME_MAX_LENGTH) return `Use ${ISSUE_VIEW_NAME_MAX_LENGTH} characters or fewer.`;
  return views.some((v) => v.id !== editingId && v.name.toLowerCase() === trimmed.toLowerCase()) ? "A view with this name already exists." : null;
}

export function readIssueSavedViews(raw: string | null | undefined): IssueSavedView[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.flatMap((item): IssueSavedView[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || seen.has(row.id)) return [];
      if (typeof row.name !== "string" || !row.name.trim() || row.name.length > ISSUE_VIEW_NAME_MAX_LENGTH) return [];
      seen.add(row.id);
      return [{ id: row.id, name: row.name, preferences: readIssueListPreferences(JSON.stringify(row.preferences ?? null)) }];
    });
  } catch {
    return [];
  }
}

export function writeIssueSavedViews(views: readonly IssueSavedView[]): string {
  return JSON.stringify(
    views.map((v) => ({ id: v.id, name: v.name.trim(), preferences: normalizeIssuePreferences(v.preferences) })),
  );
}

export const savedIssueViews = signal<IssueSavedView[]>([]);
let issueViewsLoaded = false;
export function ensureIssueSavedViewsLoaded() {
  if (issueViewsLoaded) return;
  issueViewsLoaded = true;
  void Storage.getItem(ISSUE_SAVED_VIEWS_KEY).then((raw) => {
    const read = readIssueSavedViews(raw);
    if (read.length > 0 && savedIssueViews().length === 0) savedIssueViews.set(read);
  }).catch(() => {});
}
