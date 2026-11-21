// Named pull request filter views saved locally (pullRequestSavedViews.ts + client-runtime pull-request-saved-views).
import { normalizePreferences, readPullRequestListPreferences, type PullRequestListPreferences } from "./pullRequestListPreferences";

export const PULL_REQUEST_SAVED_VIEWS_KEY = "t3.pullRequests.savedViews";
export const PULL_REQUEST_VIEW_NAME_MAX_LENGTH = 80;

export interface PullRequestSavedView {
  id: string;
  name: string;
  preferences: PullRequestListPreferences;
}

export function pullRequestViewNameError(
  name: string,
  views: readonly Pick<PullRequestSavedView, "id" | "name">[],
  editingId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for this view.";
  if (trimmed.length > PULL_REQUEST_VIEW_NAME_MAX_LENGTH) {
    return `Use ${PULL_REQUEST_VIEW_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return views.some((view) => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase())
    ? "A view with this name already exists."
    : null;
}

export function pullRequestViewMatches(view: PullRequestSavedView, preferences: PullRequestListPreferences): boolean {
  const key = (value: PullRequestListPreferences) => {
    const normalized = normalizePreferences(value);
    return JSON.stringify({ ...normalized, labels: normalized.labels ? [...normalized.labels].sort() : undefined });
  };
  return key(view.preferences) === key(preferences);
}

export function readPullRequestSavedViews(raw: string | null | undefined): PullRequestSavedView[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.flatMap((item): PullRequestSavedView[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || seen.has(row.id)) return [];
      if (typeof row.name !== "string" || !row.name.trim() || row.name.length > PULL_REQUEST_VIEW_NAME_MAX_LENGTH) return [];
      const prefs = readPullRequestListPreferences(JSON.stringify(row.preferences ?? null));
      seen.add(row.id);
      return [{ id: row.id, name: row.name, preferences: prefs }];
    });
  } catch {
    return [];
  }
}

export function writePullRequestSavedViews(views: readonly PullRequestSavedView[]): string {
  return JSON.stringify(views.map((view) => ({ id: view.id, name: view.name, preferences: normalizePreferences(view.preferences) })));
}
