// What the viewer may change on a pull request, read from the raw pullRequests.detail payload
// (client-runtime/src/pullRequestEditing.ts, and the reviewer-picker gates in PullRequestSummaryTab.tsx).

type Dict = Record<string, unknown>;

const dict = (value: unknown): Dict => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : {});
const same = (one: unknown, other: unknown): boolean =>
  typeof one === "string" && typeof other === "string" && one.trim().length > 0 && one.trim().toLowerCase() === other.trim().toLowerCase();

/** canEditPullRequestChangeRequest: the title and body can be edited. */
export function canEditChangeRequest(detail: unknown): boolean {
  const value = dict(detail);
  const capabilities = dict(value.capabilities);
  if (dict(capabilities.edit).changeRequest !== true) return false;
  const permissions = dict(value.viewerPermissions);
  if (typeof permissions.editChangeRequest === "boolean") return permissions.editChangeRequest;
  const actions = Array.isArray(permissions.actions) ? permissions.actions : [];
  return same(value.viewer, dict(value.author).login) || actions.includes("merge");
}

export interface ReviewerPickerGate {
  /** The host can request reviews and list who could be asked (Azure DevOps cannot list). */
  available: boolean;
  /** The viewer may ask someone (write access). */
  allowed: boolean;
  /** The host can search past the first page of candidates. */
  searchable: boolean;
}

export function reviewerPickerGate(detail: unknown): ReviewerPickerGate {
  const value = dict(detail);
  const reviewers = dict(dict(value.capabilities).reviewers);
  return {
    available: reviewers.request === true && reviewers.listCandidates === true,
    allowed: dict(value.viewerPermissions).requestReviewers === true,
    searchable: reviewers.searchCandidates === true,
  };
}

export interface ReviewerCandidate { id: string; kind: string; login: string; name: string; avatarUrl: string; isRequested: boolean }

export function parseReviewerCandidates(value: unknown): { candidates: ReviewerCandidate[]; truncated: boolean } {
  const list = dict(value);
  if (!Array.isArray(list.candidates)) throw new Error("The server returned invalid reviewers.");
  return {
    candidates: list.candidates.flatMap((entry) => {
      const e = dict(entry);
      return typeof e.id === "string" && e.id && typeof e.login === "string" && e.login
        ? [{ id: e.id, kind: typeof e.kind === "string" ? e.kind : "user", login: e.login, name: typeof e.name === "string" ? e.name : "", avatarUrl: typeof e.avatarUrl === "string" ? e.avatarUrl : "", isRequested: e.isRequested === true }]
        : [];
    }),
    truncated: list.truncated === true,
  };
}

/** The loaded list narrowed by what was typed (mergeReviewerCandidates without a host search). */
export function filterReviewerCandidates(candidates: readonly ReviewerCandidate[], query: string): ReviewerCandidate[] {
  const needle = query.trim().toLowerCase();
  return candidates.filter((candidate) => needle.length === 0 || candidate.login.toLowerCase().includes(needle) || candidate.name.toLowerCase().includes(needle));
}

/** The note under the list when it may be missing people (TRUNCATED_LABELS). */
export function reviewerTruncationLabel(truncated: boolean, searchable: boolean, query: string): string | null {
  if (!truncated) return null;
  if (!searchable) return "This repository has more people with access than are listed here. Ask for the rest on the host.";
  return query.trim().length === 0 ? "This repository has more people with access than are listed here. Search to find them." : "More people match than the host returned. Keep typing to narrow it down.";
}

export function reviewerRequestTitle(candidate: Pick<ReviewerCandidate, "login" | "isRequested">, ok: boolean): string {
  if (ok) return candidate.isRequested ? `Review request to ${candidate.login} taken back` : `Review requested from ${candidate.login}`;
  return candidate.isRequested ? `Could not take back the review request to ${candidate.login}` : `Could not ask ${candidate.login} for a review`;
}

export const REVIEWER_REFUSED = "The host refused it. Check that you have write access on this repository, and that they still have access to it.";
export const OFF_HEAD_CHECKOUT_TITLE = "Checked out, but not confirmed on the latest commit";

/** offHeadPullRequestCheckoutToast: the warning after a checkout that could not be confirmed at the latest commit. */
export function offHeadCheckoutToast(singular: string): { title: string; description: string } {
  return {
    title: OFF_HEAD_CHECKOUT_TITLE,
    description: `This checkout could not be confirmed at the ${singular}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.`,
  };
}

/** canEditPullRequestMaintainerEdits: the host reports the setting, the viewer may change it, and the pull request is open. */
export function canEditMaintainerEdits(detail: unknown): boolean {
  const value = dict(detail);
  return value.state === "open"
    && dict(dict(value.capabilities).edit).maintainerEdits === true
    && dict(value.viewerPermissions).maintainerEdits === true
    && typeof value.maintainerCanModify === "boolean";
}

export interface MaintainerEditsChoice { key: string; observedAt: number | undefined; value: boolean }

/**
 * A saved choice ends at the first host reading delivered after the save: readers refresh once it succeeds, which drops
 * reads still in flight, so the next reading started after the write (maintainerEditsChoiceInForce).
 */
export function maintainerEditsChoiceInForce(choice: MaintainerEditsChoice | null, key: string, observedAt: number | undefined, saving: boolean): MaintainerEditsChoice | null {
  if (choice === null || choice.key !== key) return null;
  if (saving) return choice.observedAt === observedAt ? choice : { ...choice, observedAt };
  return observedAt !== undefined && choice.observedAt === observedAt ? choice : null;
}

// ---- Host search past the first page (client-runtime pullRequestReviewers.ts) ----

const reviewerKey = (candidate: Pick<ReviewerCandidate, "kind" | "id">) => `${candidate.kind}:${candidate.id}`;

/** mergeReviewerCandidates: the loaded rows (keeping the request state a mutation updated) narrowed by the typed text, then what the host matched on its own terms. */
export function mergeReviewerCandidates(loaded: readonly ReviewerCandidate[], searched: readonly ReviewerCandidate[], query: string): ReviewerCandidate[] {
  const needle = query.trim().toLowerCase();
  const known = new Set(loaded.map(reviewerKey));
  const hostMatches = new Set(searched.map(reviewerKey));
  return [
    ...loaded.filter((candidate) => hostMatches.has(reviewerKey(candidate)) || needle.length === 0 || candidate.login.toLowerCase().includes(needle) || candidate.name.toLowerCase().includes(needle)),
    ...searched.filter((candidate) => !known.has(reviewerKey(candidate))),
  ];
}

/** hostReviewerQuery: what to ask the host for, or null when the loaded page already answers the query. */
export function hostReviewerQuery(input: { loaded: { truncated: boolean } | null; searchable: boolean; debouncedQuery: string }): string | null {
  const debounced = input.debouncedQuery.trim();
  return input.searchable && input.loaded?.truncated === true && debounced.length > 0 ? debounced : null;
}

export type ReviewerTruncation = "unsearchable" | "searchable" | "search-failed" | "search-truncated";

export const REVIEWER_TRUNCATED_LABELS: Record<ReviewerTruncation, (error: string | null) => string> = {
  unsearchable: () => "This repository has more people with access than are listed here. Ask for the rest on the host.",
  searchable: () => "This repository has more people with access than are listed here. Search to find them.",
  "search-failed": (error) => `Only the people already listed are matched: the host search failed. ${error ?? ""}`,
  "search-truncated": () => "More people match than the host returned. Keep typing to narrow it down.",
};

/** reviewerCandidateView: the rows, whether nothing matches only because the host has not answered, and why the list may be short. */
export function reviewerCandidateView(input: {
  loaded: { candidates: readonly ReviewerCandidate[]; truncated: boolean } | null;
  searchable: boolean;
  query: string;
  debouncedQuery: string;
  search: { data: { candidates: readonly ReviewerCandidate[]; truncated: boolean } | null; isPending: boolean; error: string | null };
}): { candidates: ReviewerCandidate[]; searchPending: boolean; searchError: string | null; truncation: ReviewerTruncation | null } {
  const query = input.query.trim();
  const hostQuery = hostReviewerQuery(input);
  // Only once the debounce has caught up, or rows matching the previous text would linger.
  const searched = hostQuery !== null && hostQuery === query;
  const candidates = mergeReviewerCandidates(input.loaded?.candidates ?? [], searched ? (input.search.data?.candidates ?? []) : [], query);
  const searching = input.searchable && input.loaded?.truncated === true && query.length > 0;
  const searchError = searched ? input.search.error : null;
  const truncation: ReviewerTruncation | null = input.loaded?.truncated !== true ? null
    : !input.searchable ? "unsearchable"
    : query.length === 0 ? "searchable"
    : !searched ? null
    : searchError !== null ? "search-failed"
    : input.search.data?.truncated === true ? "search-truncated"
    : null;
  return { candidates, searchPending: candidates.length === 0 && searching && (!searched || input.search.isPending), searchError, truncation };
}
