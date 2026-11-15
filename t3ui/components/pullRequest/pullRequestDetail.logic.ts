import { canEditChangeRequest, canEditMaintainerEdits, reviewerPickerGate, type ReviewerPickerGate } from "./pullRequestEditing.logic";
import type { DetailCapabilities, DetailPermissions, MergeMethod } from "./pullRequestActions.logic";
import { parseReactions, parseReviewThreads, type ReviewReaction, type ReviewThread } from "./pullRequestReview.logic";

// Parsing and arrangement for the detail panel: pullRequests.detail and pullRequests.activity
// payloads (packages/contracts pullRequest.ts), and the timeline built from them.

export interface Actor { login: string; name: string; avatarUrl: string; isBot?: boolean }
export interface DetailLabel { name: string; color: string }
export interface DetailCheck { name: string; status: string; description: string; url: string; required: boolean }

/** pullRequestChecksState: the rollup a list of checks reads as. */
export function pullRequestChecksState(checks: readonly { status: string }[]): "failing" | "pending" | "passing" | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

/** PullRequestDetailPanel checksStale: the list's newer rollup disagrees with the loaded detail's checks. */
export function resolvedDetailChecksState(listChecksState: string | null | undefined, checks: readonly { status: string }[]): string | null {
  const detailState = pullRequestChecksState(checks);
  const latest = listChecksState ? listChecksState : detailState;
  return latest !== "failing" && checks.some((check) => check.status === "action-required") ? "pending" : latest;
}

export function pullRequestChecksStale(listChecksState: string | null | undefined, checks: readonly { status: string }[]): boolean {
  return resolvedDetailChecksState(listChecksState, checks) !== pullRequestChecksState(checks);
}

export interface PullRequestDetailData {
  projectId: string;
  projectTitle: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeability: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headBranch: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string;
  closedAt: string;
  author: Actor | null;
  reviewers: Actor[];
  labels: DetailLabel[];
  checks: DetailCheck[];
  headSha: string;
  provider: string;
  capabilities: DetailCapabilities;
  permissions: DetailPermissions;
  mergeCapabilities: Record<MergeMethod, boolean>;
  autoMergeEnabled: boolean | undefined;
  /** The viewer may rename the title (canEditPullRequestChangeRequest). */
  canEditTitle: boolean;
  reviewerPicker: ReviewerPickerGate;
  /** The signed-in viewer's login, when the host reports it. */
  viewer: string;
  baseComparison: string;
  behindBy: number | null;
  /** capabilities.updateMethods and viewerPermissions.updateMethods: how the head may be brought up to date. */
  updateMethods: string[];
  viewerUpdateMethods: string[];
  headRepositoryNameWithOwner: string;
  stackRebase: boolean;
  /** Open workflow runs the host holds until someone approves them (workflowApprovalsRequired). */
  workflowApprovalsRequired: number;
  /** "Allow edits from maintainers": the host's current value, and whether the viewer may change it. */
  maintainerCanModify: boolean | undefined;
  canEditMaintainerEdits: boolean;
  /** When the host last reported this pull request, to know which reading follows a save. */
  observedAt: number | undefined;
}

export interface DetailComment { id: string; kind: string; author: Actor | null; body: string; createdAt: string; path: string; reviewState: string; editedAt: string; url: string; reactions: ReviewReaction[]; canEdit: boolean | undefined }
export interface DetailCommit { oid: string; headline: string; committedDate: string; authors: Actor[]; additions: number | null; deletions: number | null }
export interface DetailThreadComment { id: string; author: Actor | null; body: string; createdAt: string }
export interface DetailThread { id: string; path: string; line: number | null; isResolved: boolean; isOutdated: boolean; comments: DetailThreadComment[] }

export interface PullRequestActivityData {
  comments: DetailComment[];
  /** The review threads with every field the contract carries (side, paging, reactions, permissions). */
  reviewThreads: ReviewThread[];
  /** Reactions on the description. */
  reactions: ReviewReaction[];
  commits: DetailCommit[];
  threads: DetailThread[];
  commentCount: number;
  truncated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseCapabilities(value: unknown): DetailCapabilities {
  const c = record(value) ? value : {};
  const review = record(c.review) ? c.review : {};
  const edit = record(c.edit) ? c.edit : {};
  return { mentions: c.mentions === true, referenceSigils: strings(c.referenceSigils), actions: strings(c.actions), mergeMethods: strings(c.mergeMethods), comment: c.comment === true, verdicts: strings(review.verdicts), labels: edit.changeRequest === true || c.labels === true, diff: c.diff !== false, stacks: c.stacks === true, stackActions: c.stackActions === true, inlineComment: review.inlineComment === true, rangeComment: review.rangeComment === true, reply: review.reply === true, resolve: review.resolve === true, reactions: c.reactions === true, editComment: edit.comment === true, ...(c.viewedFiles === "host" || c.viewedFiles === "environment" ? { viewedFiles: c.viewedFiles } : {}), deleteBranch: c.deleteBranch === true };
}

function parsePermissions(value: unknown): DetailPermissions {
  // Unreported host permissions are granted.
  const p = record(value) ? value : {};
  return { actions: strings(p.actions), comment: p.comment !== false, verdicts: strings(p.verdicts), labels: p.labels !== false, resolve: p.resolve !== false };
}

function actor(value: unknown): Actor | null {
  if (!record(value) || !text(value.login)) return null;
  return { login: text(value.login), name: text(value.name), avatarUrl: text(value.avatarUrl), ...(typeof value.isBot === "boolean" ? { isBot: value.isBot } : {}) };
}

/** One PullRequestCheck as parseDetail reads it (also for pullRequests.checks answers). */
export function parseDetailCheck(c: unknown): DetailCheck | null {
  return record(c) && text(c.name) ? { name: text(c.name), status: text(c.status), description: text(c.description), url: text(c.url), required: c.required === true } : null;
}

export function parseDetail(value: unknown): PullRequestDetailData {
  if (!record(value) || !text(value.repository) || !text(value.title) || num(value.number) <= 0) {
    throw new Error("The server returned an invalid pull request.");
  }
  return {
    projectId: text(value.projectId), projectTitle: text(value.projectTitle), repository: text(value.repository), number: num(value.number),
    title: text(value.title), body: text(value.body), url: text(value.url), state: text(value.state), isDraft: value.isDraft === true,
    mergeability: text(value.mergeability), additions: num(value.additions), deletions: num(value.deletions), changedFiles: num(value.changedFiles),
    headBranch: text(value.headBranch), baseBranch: text(value.baseBranch), createdAt: text(value.createdAt), updatedAt: text(value.updatedAt),
    mergedAt: text(value.mergedAt), closedAt: text(value.closedAt), author: actor(value.author),
    reviewers: Array.isArray(value.reviewers) ? value.reviewers.flatMap((entry) => { const a = actor(entry); return a ? [a] : []; }) : [],
    labels: Array.isArray(value.labels) ? value.labels.flatMap((l) => (record(l) && text(l.name) ? [{ name: text(l.name), color: text(l.color) }] : [])) : [],
    headSha: text(value.headSha), provider: text(value.provider) || "github",
    capabilities: parseCapabilities(value.capabilities), permissions: parsePermissions(value.viewerPermissions),
    mergeCapabilities: { merge: record(value.mergeCapabilities) && value.mergeCapabilities.merge === true, squash: record(value.mergeCapabilities) && value.mergeCapabilities.squash === true, rebase: record(value.mergeCapabilities) && value.mergeCapabilities.rebase === true },
    autoMergeEnabled: typeof value.autoMergeEnabled === "boolean" ? value.autoMergeEnabled : undefined,
    canEditTitle: canEditChangeRequest(value), reviewerPicker: reviewerPickerGate(value), viewer: text(value.viewer),
    baseComparison: text(value.baseComparison), behindBy: typeof value.behindBy === "number" ? value.behindBy : null,
    updateMethods: strings(record(value.capabilities) ? value.capabilities.updateMethods : undefined), viewerUpdateMethods: strings(record(value.viewerPermissions) ? value.viewerPermissions.updateMethods : undefined),
    headRepositoryNameWithOwner: text(value.headRepositoryNameWithOwner), stackRebase: record(value.viewerPermissions) && value.viewerPermissions.stackRebase === true,
    workflowApprovalsRequired: num(value.workflowApprovalsRequired), maintainerCanModify: typeof value.maintainerCanModify === "boolean" ? value.maintainerCanModify : undefined,
    canEditMaintainerEdits: canEditMaintainerEdits(value), observedAt: typeof value.observedAt === "number" ? value.observedAt : undefined,
    checks: Array.isArray(value.checks) ? value.checks.flatMap((c) => (record(c) && text(c.name) ? [{ name: text(c.name), status: text(c.status), description: text(c.description), url: text(c.url), required: c.required === true }] : [])) : [],
  };
}

export function parseActivity(value: unknown): PullRequestActivityData {
  if (!record(value) || !Array.isArray(value.comments) || !Array.isArray(value.commits)) {
    throw new Error("The server returned invalid pull request activity.");
  }
  return {
    comments: value.comments.flatMap((c) => (record(c) && text(c.id) ? [{ id: text(c.id), kind: text(c.kind), author: actor(c.author), body: text(c.body), createdAt: text(c.createdAt), path: text(c.path), reviewState: text(c.reviewState), editedAt: text(c.editedAt), url: text(c.url), reactions: parseReactions(c.reactions), canEdit: typeof c.canEdit === "boolean" ? c.canEdit : undefined }] : [])),
    commits: value.commits.flatMap((c) => (record(c) && text(c.oid) ? [{ oid: text(c.oid), headline: text(c.messageHeadline), committedDate: text(c.committedDate), authors: Array.isArray(c.authors) ? c.authors.flatMap((a) => { const parsed = actor(a); return parsed ? [parsed] : []; }) : [], additions: typeof c.additions === "number" ? c.additions : null, deletions: typeof c.deletions === "number" ? c.deletions : null }] : [])),
    threads: Array.isArray(value.reviewThreads)
      ? value.reviewThreads.flatMap((t) => (record(t) && text(t.id) ? [{
        id: text(t.id), path: text(t.path), line: typeof t.line === "number" ? t.line : null, isResolved: t.isResolved === true, isOutdated: t.isOutdated === true,
        comments: Array.isArray(t.comments) ? t.comments.flatMap((c) => (record(c) && text(c.id) ? [{ id: text(c.id), author: actor(c.author), body: text(c.body), createdAt: text(c.createdAt) }] : [])) : [],
      }] : []))
      : [],
    reviewThreads: parseReviewThreads(value.reviewThreads), reactions: parseReactions(value.reactions),
    commentCount: num(value.commentCount), truncated: value.commentsTruncated === true,
  };
}

// ---- Timeline ----

export type TimelineKind = "opened" | "comment" | "review" | "commit" | "thread" | "merged" | "closed";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  at: string;
  actor: string;
  title: string;
  body: string;
  icon: string;
  /** The host comment this row shows, for its reactions and edit. */
  comment?: DetailComment;
}

const REVIEW_STATE_LABEL: Record<string, string> = {
  APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "had a review dismissed",
  approved: "approved these changes", "changes-requested": "requested changes", commented: "reviewed", dismissed: "had a review dismissed",
};

export function buildTimeline(detail: PullRequestDetailData, activity: PullRequestActivityData | null): TimelineItem[] {
  const items: TimelineItem[] = [{
    id: "opened", kind: "opened", at: detail.createdAt, actor: detail.author?.login ?? "ghost", title: "opened this pull request", body: "", icon: "git-pull-request-arrow",
  }];
  for (const comment of activity?.comments ?? []) {
    if (comment.kind === "review-comment") continue;
    const isReview = comment.kind === "review" || comment.reviewState !== "";
    items.push({
      id: `comment:${comment.id}`, kind: isReview ? "review" : "comment", at: comment.createdAt, actor: comment.author?.login ?? "ghost",
      title: isReview ? (REVIEW_STATE_LABEL[comment.reviewState] ?? "reviewed") : "commented", body: comment.body.trim(), icon: isReview ? "user-check" : "message-circle", comment,
    });
  }
  for (const thread of activity?.threads ?? []) {
    const first = thread.comments[0];
    if (!first) continue;
    items.push({
      id: `thread:${thread.id}`, kind: "thread", at: first.createdAt, actor: first.author?.login ?? "ghost",
      title: `commented on ${thread.path}${thread.line ? `:${thread.line}` : ""}${thread.isResolved ? " (resolved)" : thread.isOutdated ? " (outdated)" : ""}`,
      body: first.body.trim(), icon: "message-circle",
    });
  }
  for (const commit of activity?.commits ?? []) {
    items.push({ id: `commit:${commit.oid}`, kind: "commit", at: commit.committedDate, actor: commit.authors[0]?.login ?? "", title: commit.headline, body: commit.oid.slice(0, 7), icon: "git-branch" });
  }
  if (detail.mergedAt) items.push({ id: "merged", kind: "merged", at: detail.mergedAt, actor: "", title: "Merged", body: "", icon: "git-merge" });
  else if (detail.closedAt) items.push({ id: "closed", kind: "closed", at: detail.closedAt, actor: "", title: "Closed", body: "", icon: "git-pull-request-closed" });
  return items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

// ---- Markdown (blocks only: enough to read a description) ----

export interface MarkdownBlock { kind: "heading" | "paragraph" | "code" | "bullet" | "quote"; text: string }

export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const cleaned = source.replace(/<!--[\s\S]*?-->/gu, "").replace(/\r\n/gu, "\n");
  let code: string[] | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of cleaned.split("\n")) {
    if (/^```/u.test(line)) {
      if (code === null) { flush(); code = []; } else { blocks.push({ kind: "code", text: code.join("\n") }); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (line.trim() === "") { flush(); continue; }
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) { flush(); blocks.push({ kind: "heading", text: heading[1] ?? "" }); continue; }
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/u.exec(line);
    if (bullet) { flush(); blocks.push({ kind: "bullet", text: (bullet[1] ?? "").replace(/^\[( |x)\]\s*/u, (_, mark: string) => (mark === "x" ? "[x] " : "[ ] ")) }); continue; }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) { flush(); blocks.push({ kind: "quote", text: quote[1] ?? "" }); continue; }
    paragraph.push(line.trim());
  }
  if (code !== null) blocks.push({ kind: "code", text: code.join("\n") });
  flush();
  return blocks;
}

export const CHECK_STATUS: Record<string, { label: string; icon: string }> = {
  pending: { label: "Running", icon: "circle-dot" },
  "action-required": { label: "Awaiting action", icon: "circle-dot" },
  success: { label: "Passed", icon: "circle-check" },
  failure: { label: "Failed", icon: "circle-x" },
  cancelled: { label: "Cancelled", icon: "circle-x" },
  skipped: { label: "Skipped", icon: "circle-slash" },
  neutral: { label: "Neutral", icon: "circle-dashed" },
};

// ---- Stacks (pullRequests.stack: a native stack of changes, each layer based on the last) ----

export interface StackLayer { number: number; title: string; isDraft: boolean; headBranch: string; state: string; headSha: string }
export interface PullRequestStackData { id: string; number: number; url: string; base: string; layers: StackLayer[] }

export function parseStack(value: unknown): PullRequestStackData | null {
  if (!record(value) || !Array.isArray(value.layers)) return null;
  return {
    id: text(value.id), number: num(value.number), url: text(value.url), base: text(value.base),
    layers: value.layers.flatMap((layer): StackLayer[] => (record(layer) && num(layer.number) > 0
      ? [{ number: num(layer.number), title: text(layer.title), isDraft: layer.isDraft === true, headBranch: text(layer.headBranch), state: text(layer.state), headSha: text(layer.headSha) }]
      : [])),
  };
}

/** resolveBaseFreshness: set when an open, mergeable pull request has fallen behind its base. */
export function resolveBaseFreshness(detail: Pick<PullRequestDetailData, "state" | "mergeability" | "baseComparison" | "behindBy" | "updateMethods" | "viewerUpdateMethods">): { behindBy: number | null; methods: string[] } | null {
  if (detail.state !== "open" || detail.baseComparison !== "behind") return null;
  if (detail.mergeability !== "mergeable") return null;
  return { behindBy: detail.behindBy, methods: detail.updateMethods.filter((method) => detail.viewerUpdateMethods.includes(method)) };
}

/** isWorkflowApprovalCheck: a GitHub Actions run waiting for a maintainer to approve it. */
export function isWorkflowApprovalCheck(check: Pick<DetailCheck, "status" | "url">): boolean {
  return check.status === "action-required" && check.url !== "" && /\/actions\/runs\/\d+(?:\/|$)/u.test(check.url);
}

/** pullRequestCheckStatusLabel: "Awaiting approval" for such a run, else the status's own label. */
export function checkStatusLabel(check: Pick<DetailCheck, "status" | "url">): string {
  return isWorkflowApprovalCheck(check) ? "Awaiting approval" : (CHECK_STATUS[check.status]?.label ?? check.status);
}

/** pullRequestStackView's notice: a stack already shown while its refresh runs, or after it failed. */
export function pullRequestStackNotice(hasStack: boolean, status: "idle" | "loading" | "loaded" | "error"): string | null {
  if (!hasStack) return null;
  if (status === "error") return "Stack data may be stale. We couldn\u2019t refresh it.";
  return status === "loading" ? "Refreshing stack\u2026 Showing saved data." : null;
}
