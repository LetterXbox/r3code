// What the viewer may do with a pull request, and the request payloads for each action.
// Ported from pullRequestDetail.logic.ts (merge methods, primary control, check summaries) and the
// comment / review forms. The server decides what is allowed; this only mirrors its answer.
import type { DetailCheck, PullRequestDetailData } from "./pullRequestDetail.logic";
import type { PullRequestRefInput } from "./pullRequestDiff.logic";

export type MergeMethod = "merge" | "squash" | "rebase";
export type ReviewVerdict = "comment" | "approve" | "request-changes";
export type PullRequestActionName =
  | "merge" | "ready" | "draft" | "close" | "reopen" | "delete-branch" | "update-branch"
  | "enable-auto-merge" | "disable-auto-merge" | "revert" | "approve-workflows";

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const REVIEW_VERDICTS: { value: ReviewVerdict; label: string; sent: string }[] = [
  { value: "comment", label: "Comment", sent: "Review submitted" },
  { value: "approve", label: "Approve", sent: "Pull request approved" },
  { value: "request-changes", label: "Request changes", sent: "Changes requested" },
];

export interface DetailCapabilities {
  /** capabilities.mentions and capabilities.referenceSigils: what composers can complete (`@login`, `#123`, `!123`). */
  mentions?: boolean;
  referenceSigils?: string[];
  actions: string[];
  mergeMethods: string[];
  comment: boolean;
  verdicts: string[];
  labels: boolean;
  diff: boolean;
  stacks: boolean;
  /** capabilities.stackActions: the host merges and rebases a stack as one (merging one layer alone then waits on the stack read). */
  stackActions?: boolean;
  /** capabilities.review: the host takes line comments, ranged ones, replies and thread resolution. */
  inlineComment?: boolean;
  rangeComment?: boolean;
  reply?: boolean;
  resolve?: boolean;
  /** capabilities.reactions and capabilities.edit.comment. */
  reactions?: boolean;
  editComment?: boolean;
  /** capabilities.viewedFiles: who keeps the viewed ticks (absent: the host cannot record views). */
  viewedFiles?: "host" | "environment";
  /** capabilities.deleteBranch: the host deletes the head branch of a closed change. */
  deleteBranch?: boolean;
}

export interface DetailPermissions {
  actions: string[];
  comment: boolean;
  verdicts: string[];
  labels: boolean;
  /** Unreported host permissions are granted. */
  resolve?: boolean;
}

export interface ActionableDetail {
  state: string;
  isDraft: boolean;
  mergeability: string;
  capabilities: DetailCapabilities;
  permissions: DetailPermissions;
  mergeCapabilities: Record<MergeMethod, boolean>;
  autoMergeEnabled: boolean | undefined;
  checks: DetailCheck[];
}

export function canPerform(detail: Pick<ActionableDetail, "capabilities" | "permissions"> | null, action: PullRequestActionName): boolean {
  return detail !== null && detail.capabilities.actions.includes(action) && detail.permissions.actions.includes(action);
}

export function allowedMergeMethods(detail: Pick<ActionableDetail, "capabilities" | "mergeCapabilities"> | null): MergeMethod[] {
  if (!detail) return [];
  return (detail.capabilities.mergeMethods as MergeMethod[]).filter((method) => detail.mergeCapabilities[method]);
}

export function resolveMergeMethod(allowed: readonly MergeMethod[], current: MergeMethod | null): MergeMethod {
  return current && allowed.includes(current) ? current : (allowed[0] ?? "merge");
}

export type ChecksSummary = "none" | "pending" | "failing" | "passing";

export function classifyChecks(checks: readonly DetailCheck[]): ChecksSummary {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled")) return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) return "pending";
  return "passing";
}

export type PrimaryControl = "resolve" | "ready" | "merge" | "enable-auto-merge" | "auto-merge-armed" | "merged" | "closed" | null;

export function primaryControl(detail: ActionableDetail): PrimaryControl {
  if (detail.state === "merged") return "merged";
  if (detail.state === "closed") return "closed";
  if (detail.mergeability === "conflicting") return "resolve";
  if (detail.isDraft) return canPerform(detail, "ready") ? "ready" : null;
  if (detail.autoMergeEnabled) return "auto-merge-armed";
  const methods = allowedMergeMethods(detail);
  if (methods.length === 0) return null;
  const checks = classifyChecks(detail.checks);
  if (detail.autoMergeEnabled === false && checks !== "none" && checks !== "passing" && canPerform(detail, "enable-auto-merge")) return "enable-auto-merge";
  return canPerform(detail, "merge") ? "merge" : null;
}

export function describeChecks(checks: readonly DetailCheck[]): string {
  if (checks.length === 0) return "No checks reported";
  const failed = checks.filter((check) => check.status === "failure" || check.status === "cancelled").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const actionRequired = checks.filter((check) => check.status === "action-required").length;
  const passed = checks.filter((check) => check.status === "success").length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} of ${checks.length} running`);
  if (actionRequired > 0) parts.push(`${actionRequired} of ${checks.length} awaiting action`);
  if (failed > 0) parts.push(parts.length > 0 ? `${failed} failed` : `${failed} of ${checks.length} failing`);
  if (parts.length === 0) return passed === checks.length ? "All checks passed" : `${passed} of ${checks.length} passing`;
  return parts.join(" · ");
}

export function groupChecks(checks: readonly DetailCheck[]) {
  return {
    attention: checks.filter((check) => ["failure", "cancelled", "action-required"].includes(check.status)),
    running: checks.filter((check) => check.status === "pending"),
    completed: checks.filter((check) => ["success", "skipped", "neutral"].includes(check.status)),
  };
}

// ---- Payloads ----

export const commentPayload = (ref: PullRequestRefInput, body: string) => ({ ...ref, body });

/** Forgejo requires a summary when requesting changes, even with inline comments (`requestChangesSummaryRequired`). */
export function canSubmitReview(verdict: ReviewVerdict, summary: string, commentCount = 0, requestChangesSummaryRequired = false): boolean {
  return verdict === "request-changes" && requestChangesSummaryRequired
    ? summary.trim().length > 0
    : verdict === "approve" || summary.trim().length > 0 || commentCount > 0;
}

export function reviewPayload(ref: PullRequestRefInput, verdict: ReviewVerdict, body: string, comments: readonly object[] = []) {
  return { ...ref, verdict, body, comments };
}

/** A pending comment as the contract's PullRequestReviewCommentDraft: no local id. */
export function reviewCommentDraft(comment: { id: string; path: string; oldPath?: string; position: object; startPosition?: object; body: string }) {
  return {
    path: comment.path,
    ...(comment.oldPath ? { oldPath: comment.oldPath } : {}),
    position: comment.position,
    ...(comment.startPosition ? { startPosition: comment.startPosition } : {}),
    body: comment.body,
  };
}

export function actionPayload(ref: PullRequestRefInput, action: PullRequestActionName, mergeMethod?: MergeMethod) {
  return { ...ref, action, ...(mergeMethod && (action === "merge" || action === "enable-auto-merge") ? { mergeMethod } : {}) };
}

export interface LabelCandidate { name: string; color: string; description: string; isApplied: boolean }

/** The labels to apply and to remove to reach the chosen set, one request each (the server takes a flag). */
export function labelChanges(candidates: readonly LabelCandidate[], chosen: ReadonlySet<string>): { apply: string[]; remove: string[] } {
  return {
    apply: candidates.filter((c) => chosen.has(c.name) && !c.isApplied).map((c) => c.name),
    remove: candidates.filter((c) => !chosen.has(c.name) && c.isApplied).map((c) => c.name),
  };
}

export function parseLabelCandidates(value: unknown): { candidates: LabelCandidate[]; truncated: boolean } {
  const v = value as { candidates?: unknown; truncated?: unknown } | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.candidates)) throw new Error("The server returned invalid labels.");
  return {
    candidates: v.candidates.flatMap((entry) => {
      const e = entry as Record<string, unknown> | null;
      return e && typeof e.name === "string" && e.name
        ? [{ name: e.name, color: typeof e.color === "string" ? e.color : "", description: typeof e.description === "string" ? e.description : "", isApplied: e.isApplied === true }]
        : [];
    }),
    truncated: v.truncated === true,
  };
}

export function detailActionable(detail: PullRequestDetailData): ActionableDetail {
  return {
    state: detail.state, isDraft: detail.isDraft, mergeability: detail.mergeability, capabilities: detail.capabilities,
    permissions: detail.permissions, mergeCapabilities: detail.mergeCapabilities, autoMergeEnabled: detail.autoMergeEnabled, checks: detail.checks,
  };
}
