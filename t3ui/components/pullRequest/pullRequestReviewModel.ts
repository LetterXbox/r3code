// The Code tab's review state: the line being commented on, the pending comments, and the threads placed
// under diff lines. Pure of rendering so tests drive it with contract-shaped activity.
import { computed, signal } from "nsh";
import type { PullRequestRefInput } from "./pullRequestDiff.logic";
import type { PullRequestActivityData, PullRequestDetailData } from "./pullRequestDetail.logic";
import {
  canResolvePullRequestThread, groupReviewLines, indexPatchLines, resolveReviewAnchor,
  selectionExcerpt, type DiffViewSide, type ReviewDraft, type ReviewThread,
} from "./pullRequestReview.logic";
import { nextPendingReviewCommentId, pullRequestReviewKey, pullRequestReviewStore } from "./pullRequestReviewStore";

export function createPullRequestReviewModel(deps: {
  ref: () => PullRequestRefInput | null;
  patch: () => string;
  detail: () => PullRequestDetailData | null;
  activity: () => PullRequestActivityData | null;
  /** The commit the diff is scoped to: a commit's lines are numbered otherwise, so no comment is written on them and every thread is listed apart. */
  commit?: () => string | null;
}) {
  const draft = signal<ReviewDraft | null>(null);
  const key = () => { const ref = deps.ref(); return ref ? pullRequestReviewKey(ref) : ""; };

  const lines = computed(() => indexPatchLines(deps.patch()));
  const threads = () => deps.activity()?.reviewThreads ?? [];
  const pending = () => (key() ? pullRequestReviewStore.comments(key()) : []);

  const review = () => deps.detail()?.capabilities;
  const permissions = () => deps.detail()?.permissions;
  /** The host takes line comments and the viewer may comment. */
  const canComment = () => review()?.inlineComment === true && permissions()?.comment === true;
  const canReply = () => review()?.reply === true && permissions()?.comment === true;
  const canReact = () => review()?.reactions === true;
  const canResolve = (thread: ReviewThread) => review()?.resolve === true && deps.detail() !== null && canResolvePullRequestThread(deps.detail()!, thread);

  const scoped = () => (deps.commit?.() ?? null) !== null;
  /** canCommentOnLines: line comments need the whole change. */
  const canCommentOnLines = () => canComment() && !scoped();
  const placed = computed(() => groupReviewLines({ lines: lines(), threads: threads(), pending: scoped() ? [] : pending(), draft: scoped() ? null : draft(), placeThreads: !scoped() }));
  const groups = () => placed().groups;
  const unplaced = () => placed().unplaced;
  const annotations = () => groups().map((group) => ({ id: group.id, side: group.side, line: group.index }));
  const group = (id: string) => groups().find((entry) => entry.id === id);

  /** The "+" beside a line (or its selection) was pressed. */
  function begin(range: { side: DiffViewSide; start: number; end: number }) {
    if (scoped()) return false;
    const anchor = resolveReviewAnchor(lines(), range, review()?.rangeComment === true);
    if (anchor) draft.set(anchor);
    return anchor !== null;
  }

  function addPending(body: string) {
    const current = draft();
    if (!current || !key() || body.trim().length === 0) return;
    pullRequestReviewStore.addComment(key(), {
      id: nextPendingReviewCommentId(), path: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}),
      ...(current.startPosition ? { startPosition: current.startPosition } : {}), position: current.position, body,
    });
    draft.set(null);
  }

  /** The lines the draft selects, with their diff text, for "Add to agent". */
  const excerpt = () => { const current = draft(); return current ? selectionExcerpt(deps.patch(), current) : null; };

  return {
    excerpt,
    draft, lines, threads, pending, groups, unplaced, annotations, group,
    canComment, canCommentOnLines, scoped, canReply, canReact, canResolve,
    begin, addPending, cancel: () => draft.set(null),
    removePending: (id: string) => pullRequestReviewStore.removeComment(key(), id),
  };
}

export type PullRequestReviewModel = ReturnType<typeof createPullRequestReviewModel>;
