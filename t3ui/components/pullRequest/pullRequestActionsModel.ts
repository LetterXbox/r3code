// Mutations on the open pull request: comment, review, merge and the other actions, labels.
// Every call is a real pullRequests.* RPC (packages/contracts rpc.ts); after one succeeds the
// detail and activity are re-read quietly so the panel shows what the host now says.
import { effect, signal, untracked } from "nsh";
import {
  actionPayload, canSubmitReview, commentPayload, parseLabelCandidates, resolveMergeMethod, reviewCommentDraft, reviewPayload,
  REVIEW_VERDICTS, type LabelCandidate, type MergeMethod, type PullRequestActionName, type ReviewVerdict,
} from "./pullRequestActions.logic";
import type { PullRequestRefInput } from "./pullRequestDiff.logic";
import { parseThreadComment, type ReviewThreadComment } from "./pullRequestReview.logic";
import { showToast } from "../toast";
import { actionSuccessLabels, detailActionFailureHints, detailActionFailureLabels, readableFailure, UPDATE_BRANCH_REBASE_FAILURE_HINT } from "./pullRequestActionCopy";
import { maintainerEditsChoiceInForce, type MaintainerEditsChoice } from "./pullRequestEditing.logic";
import { pullRequestCompletionScope, type PullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { pullRequestReviewKey, pullRequestReviewStore } from "./pullRequestReviewStore";
import {
  hostReviewerQuery, parseReviewerCandidates, REVIEWER_REFUSED, reviewerCandidateView, reviewerRequestTitle, REVIEWER_TRUNCATED_LABELS, type ReviewerCandidate,
} from "./pullRequestEditing.logic";

const capitalizeTerm = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createPullRequestActionsModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  ref: () => PullRequestRefInput | null;
  refresh: () => Promise<void>;
  /** refreshFromHost (pullRequests.invalidate, then the read): pullRequestActionNeedsHostRefresh's actions use it. */
  refreshFromHost?: () => Promise<void>;
  allowedMethods: () => MergeMethod[];
  /** The host can search reviewers past the first page (capabilities.reviewers.searchCandidates). */
  reviewerSearchable?: () => boolean;
  /** What the host completes in text (`@`, `#`, `!`); null or absent completes nothing. */
  completionSupport?: () => { mentions?: boolean; referenceSigils?: readonly string[] } | null;
  /** The host's word for a change request ("pull request", "merge request"), for what an action says. */
  term?: () => string;
  /** An action the host accepted, for the list's override until its listing agrees. */
  onAction?: (action: PullRequestActionName) => void;
}) {
  const term = () => deps.term?.() ?? "pull request";
  const pending = signal<string | null>(null);
  /** "Finish review" on the Guide: counts up so the composer opens its Review tab. */
  const reviewRequest = signal(0);
  const requestReview = () => reviewRequest.update((count) => count + 1);
  const error = signal("");
  const notice = signal("");
  const chosenMethod = signal<MergeMethod | null>(null);
  const armed = signal<string | null>(null);
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;

  const mergeMethod = () => resolveMergeMethod(deps.allowedMethods(), chosenMethod());

  function arm(key: string) {
    armed.set(key);
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => armed.set(null), 4000);
  }

  /** The first press arms a destructive action, the second runs it (useInlineActionConfirm). */
  function confirmThen(key: string, run: () => void) {
    if (armed() === key) {
      armed.set(null);
      if (disarmTimer) clearTimeout(disarmTimer);
      run();
    } else arm(key);
  }

  /** `failureTitle`: the reference reports this one with a toast of that title instead of the inline error. */
  async function mutate(label: string, work: (ref: PullRequestRefInput) => Promise<unknown>, success: string, failureTitle?: string | { title: string; hint: string }): Promise<boolean> {
    const ref = deps.ref();
    if (!ref || pending() !== null) return false;
    pending.set(label);
    error.set("");
    notice.set("");
    try {
      await work(ref);
      notice.set(success);
      await deps.refresh();
      return true;
    } catch (cause) {
      if (typeof failureTitle === "string") showToast({ type: "error", title: failureTitle });
      else if (failureTitle) showToast({ type: "error", title: failureTitle.title, description: readableFailure(cause, failureTitle.hint) });
      else error.set(message(cause));
      return false;
    } finally {
      pending.set(null);
    }
  }

  /**
   * pullRequests.runAction with a toast for each end (usePullRequestActionRunner): the success title, or the failure title
   * with what the host said, or a hint when it only said that a tool failed. The panel is then re-read.
   */
  async function runAction(action: PullRequestActionName, payload: (ref: PullRequestRefInput) => object, hint?: string): Promise<boolean> {
    const ref = deps.ref();
    if (!ref || pending() !== null) return false;
    pending.set(action);
    error.set("");
    notice.set("");
    try {
      try {
        await deps.request("pullRequests.runAction", payload(ref));
      } catch (cause) {
        showToast({ type: "error", title: detailActionFailureLabels(term())[action], description: readableFailure(cause, hint ?? detailActionFailureHints(term())[action]) });
        return false;
      }
      showToast({ type: "success", title: actionSuccessLabels(term())[action] });
      deps.onAction?.(action);
      // pullRequestActionNeedsHostRefresh: update-branch and approve-workflows change what the host caches.
      await ((action === "update-branch" || action === "approve-workflows") && deps.refreshFromHost ? deps.refreshFromHost() : deps.refresh());
      return true;
    } finally {
      pending.set(null);
    }
  }

  const perform = (action: PullRequestActionName, method?: MergeMethod) => runAction(action, (ref) => actionPayload(ref, action, method));

  /** PullRequestCommentForm submit("comment"): a failure is the toast "Could not post the comment". */
  const comment = async (body: string): Promise<boolean> => {
    const ref = deps.ref();
    if (body.trim().length === 0 || !ref || pending() !== null) return false;
    pending.set("comment");
    error.set("");
    notice.set("");
    try {
      await deps.request("pullRequests.comment", commentPayload(ref, body.trim()));
    } catch {
      pending.set(null);
      showToast({ type: "error", title: "Could not post the comment" });
      return false;
    }
    pending.set(null);
    await deps.refresh();
    return true;
  };

  /** performCommentAction: posts the comment, then closes or reopens; the comment is re-read even when the action fails. */
  const commentAction = async (body: string, action: "close" | "reopen"): Promise<{ commentPosted: boolean }> => {
    const ref = deps.ref();
    if (body.trim().length === 0 || !ref || pending() !== null) return { commentPosted: false };
    pending.set(action);
    try {
      await deps.request("pullRequests.comment", commentPayload(ref, body.trim()));
    } catch {
      pending.set(null);
      showToast({ type: "error", title: "Could not post the comment" });
      return { commentPosted: false };
    }
    pending.set(null);
    const ok = await runAction(action, (target) => actionPayload(target, action));
    if (!ok) await deps.refresh();
    return { commentPosted: true };
  };

  /** Submits the verdict with the summary and every pending line comment of this pull request (PullRequestReviewForm). */
  const submitReview = async (verdict: ReviewVerdict, body: string, summaryRequired = false): Promise<boolean> => {
    const ref = deps.ref();
    if (!ref) return false;
    const key = pullRequestReviewKey(ref);
    const submitted = pullRequestReviewStore.comments(key);
    if (!canSubmitReview(verdict, body, submitted.length, summaryRequired)) return false;
    const ok = await mutate(
      "review",
      (target) => deps.request("pullRequests.submitReview", reviewPayload(target, verdict, body, submitted.map(reviewCommentDraft))),
      "",
      { title: "The review could not be submitted", hint: "The host refused the review. Your draft is still here to try again." },
    );
    if (ok) {
      // PullRequestReviewForm: the verdict's own words as a success toast ("<Term> approved" follows the host's word).
      const sent = verdict === "approve" ? `${capitalizeTerm(term())} approved` : REVIEW_VERDICTS.find((v) => v.value === verdict)?.sent ?? "Review submitted";
      showToast({ type: "success", title: sent });
      // Keep comments and summary edits made while the review was sent.
      pullRequestReviewStore.removeComments(key, submitted.map((comment) => comment.id));
      pullRequestReviewStore.clearSummary(key, body);
    }
    return ok;
  };

  /** The pending review (summary and line comments) of the open pull request. */
  const reviewKey = () => { const ref = deps.ref(); return ref ? pullRequestReviewKey(ref) : ""; };
  const reviewSummary = () => pullRequestReviewStore.summary(reviewKey());
  const setReviewSummary = (body: string) => pullRequestReviewStore.setSummary(reviewKey(), body);
  const pendingReviewComments = () => pullRequestReviewStore.comments(reviewKey()).length;
  /** PullRequestComposer's Discard pending line comments. */
  const discardPendingReviewComments = () => pullRequestReviewStore.removeComments(reviewKey(), pullRequestReviewStore.comments(reviewKey()).map((comment) => comment.id));

  // ---- Review threads, reactions and edits ----
  const replyToThread = (threadId: string, body: string) =>
    body.trim().length === 0 ? Promise.resolve(false)
      : mutate(`thread:${threadId}`, (ref) => deps.request("pullRequests.replyToThread", { ...ref, threadId, body }), "Reply posted", "Reply could not be posted");

  const setThreadResolved = (threadId: string, resolved: boolean) =>
    mutate(`thread:${threadId}`, (ref) => deps.request("pullRequests.setThreadResolution", { ...ref, threadId, resolved }), resolved ? "Conversation resolved" : "Conversation reopened", "The conversation could not be updated");

  /** One page of a thread's later comments (pullRequests.threadComments). */
  async function loadThreadComments(threadId: string, cursor: string): Promise<{ comments: ReviewThreadComment[]; nextCursor: string | null } | null> {
    const ref = deps.ref();
    if (!ref) return null;
    try {
      const result = await deps.request("pullRequests.threadComments", { ...ref, threadId, cursor }) as { comments?: unknown; nextCursor?: unknown } | null;
      return {
        comments: Array.isArray(result?.comments) ? result.comments.flatMap(parseThreadComment) : [],
        nextCursor: typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null,
      };
    } catch {
      showToast({ type: "error", title: "More comments could not be loaded" });
      return null;
    }
  }

  /** Reacts to a comment, or to the description when `subjectId` is omitted. Throws so the bar can undo its optimistic pill. */
  async function setReaction(subjectId: string | undefined, content: string, reacted: boolean): Promise<void> {
    const ref = deps.ref();
    if (!ref) throw new Error("No pull request is open.");
    await deps.request("pullRequests.setReaction", { ...ref, ...(subjectId === undefined ? {} : { subjectId }), content, reacted });
    await deps.refresh();
  }

  /** pullRequests.updateComment: the kind picks the endpoint. */
  /** `failureTitle`: the toast when the host refuses (the Code tab's review threads say "The comment could not be saved"). */
  const updateComment = (commentId: string, kind: "issue-comment" | "review-comment", body: string, failureTitle = "Could not save the comment") =>
    body.trim().length === 0 ? Promise.resolve(false)
      : mutate(`edit:${commentId}`, (ref) => deps.request("pullRequests.updateComment", { ...ref, commentId, kind, body }), "Comment updated", failureTitle);

  /** pullRequests.update with a new description. */
  const updateBody = (body: string) =>
    mutate("description", (ref) => deps.request("pullRequests.update", { ...ref, body }), "Description updated", "Could not save the description");

  /**
   * "Allow edits from maintainers": the chosen value shows at once and holds until the host's next reading, and a failed save
   * restores the earlier one with a toast (PullRequestActionsMenu saveMaintainerEdits).
   */
  const maintainerChoice = signal<MaintainerEditsChoice | null>(null);
  const maintainerSaving = signal(false);
  const setMaintainerEdits = async (value: boolean, current: { key: string; observedAt: number | undefined }): Promise<boolean> => {
    const ref = deps.ref();
    if (!ref || maintainerSaving()) return false;
    const previous = maintainerChoice();
    maintainerChoice.set({ key: current.key, observedAt: current.observedAt, value });
    maintainerSaving.set(true);
    try {
      await deps.request("pullRequests.update", { ...ref, maintainerCanModify: value });
    } catch (cause) {
      maintainerSaving.set(false);
      maintainerChoice.set(previous);
      showToast({ type: "error", title: "Could not save maintainer access", description: readableFailure(cause, "Try again.") });
      return false;
    }
    maintainerSaving.set(false);
    await deps.refresh();
    return true;
  };
  /** The choice in force for the reading the panel holds: it ends at the first reading after the save. */
  const maintainerEditsValue = (detail: { maintainerCanModify: boolean | undefined; observedAt: number | undefined }, key: string): boolean | undefined => {
    const kept = maintainerEditsChoiceInForce(maintainerChoice(), key, detail.observedAt, maintainerSaving());
    return kept?.value ?? detail.maintainerCanModify;
  };

  /** Brings the head up to date with its base (the base-branch warning's buttons): `updateMethod` is "merge" or "rebase". */
  const updateBranch = (updateMethod: string) =>
    runAction("update-branch", (ref) => ({ ...ref, action: "update-branch", updateMethod }), updateMethod === "rebase" ? UPDATE_BRANCH_REBASE_FAILURE_HINT : undefined);

  /**
   * A stack-wide merge or rebase (PullRequestStackMenu run): `payloadOf` builds the pullRequests.runAction input from the open
   * pull request's ref. The panel is re-read after a refusal too, and `error` holds what the host said (or the hint).
   */
  const runStackAction = async (payloadOf: (ref: PullRequestRefInput) => object | null, success: string, hint = "The host refused it."): Promise<boolean> => {
    const ref = deps.ref();
    if (!ref || pending() !== null) return false;
    pending.set("stack");
    error.set("");
    notice.set("");
    try {
      const payload = payloadOf(ref);
      if (!payload) throw new Error("A layer's head commit is unknown. Refresh the stack and try again.");
      await deps.request("pullRequests.runAction", payload);
      notice.set(success);
      return true;
    } catch (cause) {
      error.set(readableFailure(cause, hint));
      return false;
    } finally {
      pending.set(null);
      await deps.refresh();
    }
  };

  // ---- Labels ----
  const labelsOpen = signal(false);
  const candidates = signal<LabelCandidate[]>([]);
  const labelsStatus = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const labelsTruncated = signal(false);
  const labelsError = signal("");
  /** The label being put on or taken off (PullRequestLabelPicker's pending). */
  const labelPending = signal<string | null>(null);

  async function loadLabels() {
    const ref = deps.ref();
    if (!ref) return;
    labelsStatus.set("loading");
    try {
      const parsed = parseLabelCandidates(await deps.request("pullRequests.labelCandidates", ref));
      candidates.set(parsed.candidates);
      labelsTruncated.set(parsed.truncated);
      labelsStatus.set("loaded");
    } catch (cause) {
      labelsError.set(message(cause));
      labelsStatus.set("error");
    }
  }

  function toggleLabelsMenu() {
    const next = !labelsOpen();
    labelsOpen.set(next);
    if (next) void loadLabels();
  }

  /** PullRequestLabelPicker toggle: one pullRequests.setLabels per press; a refusal is the reference's toast. */
  async function toggleLabel(name: string) {
    const target = candidates().find((entry) => entry.name === name);
    const ref = deps.ref();
    if (!target || !ref || labelPending() !== null) return;
    labelPending.set(name);
    try {
      await deps.request("pullRequests.setLabels", { ...ref, labels: [name], applied: !target.isApplied });
    } catch (cause) {
      showToast({
        type: "error",
        title: target.isApplied ? `Could not take ${name} off` : `Could not put ${name} on`,
        description: readableFailure(cause, "The host refused it. Check that you have triage access on this repository."),
      });
      return;
    } finally {
      labelPending.set(null);
    }
    candidates.update((all) => all.map((c) => (c.name === name ? { ...c, isApplied: !c.isApplied } : c)));
    await deps.refresh();
  }

  // ---- Title ----
  /** The title being edited, or null when it is shown (PullRequestTitleEditor's titleDraft). */
  const titleDraft = signal<string | null>(null);
  const titleSaving = signal(false);
  const titleError = signal("");

  function editTitle(current: string) {
    titleError.set("");
    titleDraft.set(current);
  }

  function cancelTitle() {
    titleDraft.set(null);
    titleError.set("");
  }

  /** pullRequests.update with the new title; an empty or unchanged one just closes the editor. */
  async function saveTitle(current: string, next: string): Promise<boolean> {
    const title = next.trim();
    const ref = deps.ref();
    if (!ref || titleSaving()) return false;
    if (title.length === 0 || title === current) {
      cancelTitle();
      return false;
    }
    titleSaving.set(true);
    titleError.set("");
    try {
      await deps.request("pullRequests.update", { ...ref, title });
      titleDraft.set(null);
      await deps.refresh();
      return true;
    } catch (cause) {
      showToast({ type: "error", title: "The title could not be saved", description: readableFailure(cause, "The host refused the new title.") });
      return false;
    } finally {
      titleSaving.set(false);
    }
  }

  // ---- Reviewers ----
  const reviewersOpen = signal(false);
  const reviewerQuery = signal("");
  const reviewers = signal<ReviewerCandidate[]>([]);
  const reviewersStatus = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const reviewersTruncated = signal(false);
  const reviewerError = signal("");
  const reviewerNotice = signal("");
  const reviewerPending = signal<string | null>(null);

  // The host is asked for people past the first page once the loaded list is truncated and something is typed (a 250 ms debounce).
  const debouncedReviewerQuery = signal("");
  effect(() => {
    const typed = reviewerQuery().trim();
    const timer = setTimeout(() => debouncedReviewerQuery.set(typed), 250);
    return () => clearTimeout(timer);
  });
  const reviewerSearch = signal<{ candidates: ReviewerCandidate[]; truncated: boolean } | null>(null);
  const reviewerSearchStatus = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const reviewerSearchError = signal("");
  let searchSequence = 0;
  const loadedReviewers = () => (reviewersStatus() === "loaded" ? { candidates: reviewers(), truncated: reviewersTruncated() } : null);
  const reviewerHostQuery = () => hostReviewerQuery({ loaded: loadedReviewers(), searchable: deps.reviewerSearchable?.() === true, debouncedQuery: debouncedReviewerQuery() });
  async function searchReviewers(query: string) {
    const ref = deps.ref();
    if (!ref) return;
    const request = ++searchSequence;
    reviewerSearchStatus.set("loading");
    reviewerSearchError.set("");
    try {
      const parsed = parseReviewerCandidates(await deps.request("pullRequests.reviewerCandidates", { ...ref, query }));
      if (request !== searchSequence) return;
      reviewerSearch.set(parsed);
      reviewerSearchStatus.set("loaded");
    } catch (cause) {
      if (request !== searchSequence) return;
      reviewerSearch.set(null);
      reviewerSearchError.set(message(cause));
      reviewerSearchStatus.set("error");
    }
  }
  effect(() => {
    const query = reviewersOpen() ? reviewerHostQuery() : null;
    if (query === null) { searchSequence++; return; }
    untracked(() => void searchReviewers(query));
  });
  const reviewerView = () => reviewerCandidateView({
    loaded: loadedReviewers(),
    searchable: deps.reviewerSearchable?.() === true,
    query: reviewerQuery(),
    debouncedQuery: debouncedReviewerQuery(),
    search: { data: reviewerSearch(), isPending: reviewerSearchStatus() === "loading", error: reviewerSearchStatus() === "error" ? reviewerSearchError() : null },
  });
  const visibleReviewers = () => reviewerView().candidates;
  /** The picker's pending state: the load, or a search nothing has answered yet. */
  const reviewersPending = () => reviewersStatus() === "loading" || reviewerView().searchPending;
  /** The picker's error: the load's, else the search's when nothing matches. */
  const reviewersListError = (): string | null => (reviewersStatus() === "error" ? reviewerError() : reviewerView().candidates.length === 0 ? reviewerView().searchError : null);
  const reviewersTruncationNote = (): string | null => {
    const view = reviewerView();
    return view.truncation === null ? null : REVIEWER_TRUNCATED_LABELS[view.truncation](view.searchError);
  };

  async function loadReviewers() {
    const ref = deps.ref();
    if (!ref) return;
    reviewersStatus.set("loading");
    try {
      const parsed = parseReviewerCandidates(await deps.request("pullRequests.reviewerCandidates", ref));
      reviewers.set(parsed.candidates);
      reviewersTruncated.set(parsed.truncated);
      reviewersStatus.set("loaded");
    } catch (cause) {
      reviewerError.set(message(cause));
      reviewersStatus.set("error");
    }
  }

  function toggleReviewersMenu() {
    const next = !reviewersOpen();
    reviewersOpen.set(next);
    reviewerQuery.set("");
    reviewerError.set("");
    reviewerNotice.set("");
    if (next) void loadReviewers();
  }

  /** pullRequests.requestReviewers: asks, or takes back, one review request. */
  async function toggleReviewer(candidate: ReviewerCandidate): Promise<boolean> {
    const ref = deps.ref();
    if (!ref || reviewerPending() !== null) return false;
    reviewerPending.set(candidate.id);
    reviewerError.set("");
    reviewerNotice.set("");
    try {
      await deps.request("pullRequests.requestReviewers", { ...ref, reviewers: [{ id: candidate.id, kind: candidate.kind }], requested: !candidate.isRequested });
      const flip = (all: ReviewerCandidate[]) => all.map((entry) => (entry.id === candidate.id && entry.kind === candidate.kind ? { ...entry, isRequested: !entry.isRequested } : entry));
      reviewers.update(flip);
      // Somebody found only by the host's search keeps the new state in the answer on screen.
      reviewerSearch.update((answer) => (answer ? { ...answer, candidates: flip(answer.candidates) } : answer));
      // PullRequestReviewerPicker toasts both ends.
      showToast({ type: "success", title: reviewerRequestTitle(candidate, true) });
      await deps.refresh();
      return true;
    } catch (cause) {
      showToast({ type: "error", title: reviewerRequestTitle(candidate, false), description: readableFailure(cause, REVIEWER_REFUSED) });
      return false;
    } finally {
      reviewerPending.set(null);
    }
  }

  /** The completion scope the pull request's composers share: the host's reach into this repository's users and references. */
  const completion = (): PullRequestCompletionScope | null => {
    const support = deps.completionSupport?.();
    const ref = deps.ref();
    return support && ref ? pullRequestCompletionScope({ capabilities: { mentions: support.mentions, referenceSigils: [...(support.referenceSigils ?? [])] }, projectId: ref.projectId, ...(ref.host ? { host: ref.host } : {}) }, deps.request) : null;
  };

  return {
    reviewRequest, requestReview,
    completion,
    titleDraft, titleSaving, titleError, editTitle, cancelTitle, saveTitle,
    reviewersOpen, reviewerQuery, reviewers, visibleReviewers, reviewersPending, reviewersListError, reviewersTruncationNote, reviewersStatus, reviewersTruncated, reviewerError, reviewerNotice, reviewerPending,
    toggleReviewersMenu, toggleReviewer,
    pending, error, notice, armed, confirmThen, mergeMethod, chosenMethod, perform, updateBranch, runStackAction, comment, commentAction, submitReview,
    reviewSummary, setReviewSummary, pendingReviewComments, discardPendingReviewComments,
    maintainerSaving, setMaintainerEdits, maintainerEditsValue,
    replyToThread, setThreadResolved, loadThreadComments, setReaction, updateComment, updateBody,
    labelsOpen, toggleLabelsMenu, candidates, labelsStatus, labelsTruncated, labelsError, labelPending, toggleLabel,
  };
}

const ACTION_SENT: Record<string, string> = {
  merge: "Merged", ready: "Marked ready for review", draft: "Converted to draft", close: "Closed", reopen: "Reopened",
  "delete-branch": "Branch deleted", "update-branch": "Branch updated", "enable-auto-merge": "Auto-merge enabled",
  "disable-auto-merge": "Auto-merge disabled", revert: "Revert started", "approve-workflows": "Workflows approved",
};

export type PullRequestActionsModel = ReturnType<typeof createPullRequestActionsModel>;
