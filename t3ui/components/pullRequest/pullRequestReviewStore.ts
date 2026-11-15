// Pending inline review comments and the review summary, kept per pull request until the review is
// submitted. Ported from pullRequestReviewStore.ts (a zustand store there, signals here).
import { signal } from "nsh";
import type { PendingReviewComment } from "./pullRequestReview.logic";

export type { PendingReviewComment };

// Content-derived ids can collide across comments; use a counter.
let pendingCommentSequence = 0;

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
}

export function pullRequestReviewKey(reference: { projectId: string; host?: string | undefined; repository: string; number: number }): string {
  return JSON.stringify([reference.projectId, reference.host?.toLowerCase() ?? null, reference.repository.toLowerCase(), reference.number]);
}

const EMPTY: readonly PendingReviewComment[] = [];

export function createPullRequestReviewStore() {
  const drafts = signal<Readonly<Record<string, readonly PendingReviewComment[]>>>({});
  const summaries = signal<Readonly<Record<string, string>>>({});

  const without = <T,>(record: Readonly<Record<string, T>>, key: string) => {
    const { [key]: _removed, ...rest } = record;
    return rest;
  };

  return {
    comments: (key: string): readonly PendingReviewComment[] => drafts()[key] ?? EMPTY,
    summary: (key: string): string => summaries()[key] ?? "",
    addComment(key: string, comment: PendingReviewComment) {
      drafts.update((all) => ({ ...all, [key]: [...(all[key] ?? EMPTY), comment] }));
    },
    removeComments(key: string, ids: readonly string[]) {
      const gone = new Set(ids);
      drafts.update((all) => {
        const remaining = (all[key] ?? EMPTY).filter((entry) => !gone.has(entry.id));
        return remaining.length > 0 ? { ...all, [key]: remaining } : without(all, key);
      });
    },
    removeComment(key: string, id: string) {
      this.removeComments(key, [id]);
    },
    clear(key: string) {
      drafts.update((all) => without(all, key));
    },
    setSummary(key: string, body: string) {
      summaries.update((all) => ({ ...all, [key]: body }));
    },
    /** Keep summary edits made while the review was being submitted. */
    clearSummary(key: string, submittedBody: string) {
      summaries.update((all) => (all[key] !== submittedBody ? all : without(all, key)));
    },
  };
}

/** The app's one store: panels come and go but a half-written review stays. */
export const pullRequestReviewStore = createPullRequestReviewStore();
