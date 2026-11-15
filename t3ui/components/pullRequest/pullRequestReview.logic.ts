// Inline review on the Code tab's diff: which diff line a comment sits on and where a host's review
// thread goes. Ported from the anchoring in reviewCommentContext.ts (resolveDiffReviewAnchor) and
// PullRequestCodeTab.tsx (reviewThreadsByPath, getReviewPositionAnchor).
//
// The native DiffView numbers the lines of a multi-file patch as one flat text per side: the n-th shown
// line of the old (context and deleted) or new (context and added) side, counting across every file's
// hunks from 0. `indexPatchLines` rebuilds that numbering so a line pressed in the view resolves to a
// file and a contract position (PullRequestReviewPosition), and a thread's host line to a view line.

export type ReviewSide = "left" | "right";
export type DiffViewSide = "old" | "new";

export type ReviewPosition =
  | { kind: "added"; newLine: number }
  | { kind: "deleted"; oldLine: number }
  | { kind: "context"; oldLine: number; newLine: number; side: ReviewSide };

export interface ReviewPatchLine {
  path: string;
  oldPath: string | null;
  hunk: number;
  kind: "context" | "added" | "deleted";
  /** 1-based line numbers in the file; 0 where the line is not on that side. */
  oldLine: number;
  newLine: number;
  /** The DiffView's flat index on each side, or -1 where the line is not on that side. */
  oldIndex: number;
  newIndex: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//u, "");
}

/** Every shown line of a unified diff with its file numbers and the DiffView's flat indices. */
export function indexPatchLines(patch: string): ReviewPatchLine[] {
  const out: ReviewPatchLine[] = [];
  let path = "";
  let oldPath = "";
  let inHunk = false;
  let hunk = -1;
  let oldNo = 0;
  let newNo = 0;
  let oldIndex = 0;
  let newIndex = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      oldPath = match?.[1] ?? "";
      path = match?.[2] ?? "";
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- ")) { if (line !== "--- /dev/null") oldPath = stripPrefix(line.slice(4)); continue; }
      if (line.startsWith("+++ ")) { if (line !== "+++ /dev/null") path = stripPrefix(line.slice(4)); continue; }
    }
    const header = HUNK.exec(line);
    if (header) {
      inHunk = true;
      hunk += 1;
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    const mark = line[0];
    if (mark === "+") {
      out.push({ path, oldPath: oldPath === path ? null : oldPath, hunk, kind: "added", oldLine: 0, newLine: newNo, oldIndex: -1, newIndex });
      newNo += 1; newIndex += 1;
    } else if (mark === "-") {
      out.push({ path, oldPath: oldPath === path ? null : oldPath, hunk, kind: "deleted", oldLine: oldNo, newLine: 0, oldIndex, newIndex: -1 });
      oldNo += 1; oldIndex += 1;
    } else if (mark === " ") {
      out.push({ path, oldPath: oldPath === path ? null : oldPath, hunk, kind: "context", oldLine: oldNo, newLine: newNo, oldIndex, newIndex });
      oldNo += 1; newNo += 1; oldIndex += 1; newIndex += 1;
    }
  }
  return out;
}

function lineAt(lines: ReviewPatchLine[], side: DiffViewSide, index: number): ReviewPatchLine | undefined {
  return lines.find((entry) => (side === "old" ? entry.oldIndex : entry.newIndex) === index);
}

function positionOf(entry: ReviewPatchLine, side: DiffViewSide): ReviewPosition {
  if (entry.kind === "added") return { kind: "added", newLine: entry.newLine };
  if (entry.kind === "deleted") return { kind: "deleted", oldLine: entry.oldLine };
  return { kind: "context", oldLine: entry.oldLine, newLine: entry.newLine, side: side === "old" ? "left" : "right" };
}

export interface ReviewAnchor {
  path: string;
  oldPath: string | null;
  position: ReviewPosition;
  startPosition?: ReviewPosition;
  /** The pressed lines, for the annotation the draft sits under. */
  side: DiffViewSide;
  endIndex: number;
}

/**
 * Where a comment on the selected lines is anchored. With `ranged` (the host's review.rangeComment), a
 * selection inside one hunk of one file keeps its first line as `startPosition`; otherwise the comment
 * sits on the line the selection ended on.
 */
export function resolveReviewAnchor(
  lines: ReviewPatchLine[], range: { side: DiffViewSide; start: number; end: number }, ranged: boolean,
): ReviewAnchor | null {
  const last = lineAt(lines, range.side, range.end);
  if (!last) return null;
  const anchor: ReviewAnchor = { path: last.path, oldPath: last.oldPath, position: positionOf(last, range.side), side: range.side, endIndex: range.end };
  if (!ranged || range.start === range.end) return anchor;
  const first = lineAt(lines, range.side, Math.min(range.start, range.end));
  const end = lineAt(lines, range.side, Math.max(range.start, range.end));
  if (!first || !end || first.path !== end.path || first.hunk !== end.hunk) return anchor;
  return { ...anchor, position: positionOf(end, range.side), startPosition: positionOf(first, range.side) };
}

/** What a diff selection holds, for handing it to an agent (buildDiffReviewComment): the file, the host lines and the diff text. */
export interface SelectionExcerpt { path: string; side: "old" | "new"; startLine: number; endLine: number; text: string }

/** The lines the anchor selects, from the same hunks `indexPatchLines` numbers, with their diff marks. */
export function selectionExcerpt(patch: string, anchor: ReviewAnchor): SelectionExcerpt | null {
  const lines = indexPatchLines(patch);
  const bodies: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (HUNK.test(line)) { inHunk = true; continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line[0] === "+" || line[0] === "-" || line[0] === " ") bodies.push(line);
  }
  const end = lines.findIndex((entry) => (anchor.side === "old" ? entry.oldIndex : entry.newIndex) === anchor.endIndex);
  if (end < 0) return null;
  const startAnchor = anchor.startPosition ? lines.findIndex((entry) => entry.path === anchor.path && samePosition(positionOf(entry, anchor.side), anchor.startPosition as ReviewPosition)) : -1;
  const start = startAnchor >= 0 && startAnchor <= end ? startAnchor : end;
  const picked = lines.slice(start, end + 1);
  const numberOf = (entry: ReviewPatchLine) => (anchor.side === "old" ? entry.oldLine : entry.newLine) || entry.newLine || entry.oldLine;
  return { path: anchor.path, side: anchor.side, startLine: numberOf(picked[0]!), endLine: numberOf(picked[picked.length - 1]!), text: bodies.slice(start, end + 1).join("\n") };
}

function samePosition(left: ReviewPosition, right: ReviewPosition): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "added" && right.kind === "added") return left.newLine === right.newLine;
  if (left.kind === "deleted" && right.kind === "deleted") return left.oldLine === right.oldLine;
  return left.kind === "context" && right.kind === "context" && left.oldLine === right.oldLine && left.newLine === right.newLine;
}

/** getReviewPositionAnchor: the host line and side a position names. */
export function positionAnchor(position: ReviewPosition): { line: number; side: ReviewSide } {
  switch (position.kind) {
    case "added": return { line: position.newLine, side: "right" };
    case "deleted": return { line: position.oldLine, side: "left" };
    case "context": return { line: position.side === "left" ? position.oldLine : position.newLine, side: position.side };
  }
}

/** The DiffView line a host line (1-based, `left` old or `right` new) is shown on, or null when the patch does not show it. */
export function viewLineFor(lines: ReviewPatchLine[], path: string, line: number | null, side: ReviewSide): { side: DiffViewSide; index: number } | null {
  if (line === null) return null;
  for (const entry of lines) {
    if (entry.path !== path) continue;
    if (side === "left" && entry.oldLine === line && entry.oldIndex >= 0) return { side: "old", index: entry.oldIndex };
    if (side === "right" && entry.newLine === line && entry.newIndex >= 0) return { side: "new", index: entry.newIndex };
  }
  return null;
}

// ---- Review threads (pullRequests.detail/activity reviewThreads) ----

export interface ReviewReaction { content: string; count: number; actors: string[]; viewerHasReacted: boolean }
export interface ReviewActor { login: string; name: string; avatarUrl: string; isBot?: boolean }
export interface ReviewThreadComment {
  id: string; author: ReviewActor | null; body: string; createdAt: string; editedAt: string | null; url: string;
  reactions: ReviewReaction[]; canEdit: boolean | undefined;
}
export interface ReviewThread {
  id: string; path: string; line: number | null; side: ReviewSide; isResolved: boolean; isOutdated: boolean;
  comments: ReviewThreadComment[]; commentCount: number; nextCommentsCursor: string | null; canResolve: boolean | undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (value: unknown) => (typeof value === "string" ? value : "");

export function parseReactions(value: unknown): ReviewReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => record(entry) && str(entry.content) && typeof entry.count === "number" && entry.count > 0
    ? [{ content: str(entry.content), count: entry.count, actors: Array.isArray(entry.actors) ? entry.actors.filter((a): a is string => typeof a === "string") : [], viewerHasReacted: entry.viewerHasReacted === true }]
    : []);
}

function parseActor(value: unknown): ReviewActor | null {
  return record(value) && str(value.login) ? { login: str(value.login), name: str(value.name), avatarUrl: str(value.avatarUrl), ...(typeof value.isBot === "boolean" ? { isBot: value.isBot } : {}) } : null;
}

export function parseThreadComment(value: unknown): ReviewThreadComment[] {
  if (!record(value) || !str(value.id)) return [];
  return [{
    id: str(value.id), author: parseActor(value.author), body: str(value.body), createdAt: str(value.createdAt),
    editedAt: str(value.editedAt) || null, url: str(value.url), reactions: parseReactions(value.reactions), canEdit: typeof value.canEdit === "boolean" ? value.canEdit : undefined,
  }];
}

export function parseReviewThreads(value: unknown): ReviewThread[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!record(entry) || !str(entry.id) || !str(entry.path)) return [];
    const comments = Array.isArray(entry.comments) ? entry.comments.flatMap(parseThreadComment) : [];
    return [{
      id: str(entry.id), path: str(entry.path), line: typeof entry.line === "number" ? entry.line : null,
      side: entry.side === "left" ? "left" as const : "right" as const, isResolved: entry.isResolved === true, isOutdated: entry.isOutdated === true,
      comments, commentCount: typeof entry.commentCount === "number" ? entry.commentCount : comments.length,
      nextCommentsCursor: str(entry.nextCommentsCursor) || null, canResolve: typeof entry.canResolve === "boolean" ? entry.canResolve : undefined,
    }];
  });
}

export function mergeThreadComments<T extends { id: string }>(base: readonly T[], loaded: readonly T[]): T[] {
  const seen = new Set(base.map((comment) => comment.id));
  return [...base, ...loaded.filter((comment) => (seen.has(comment.id) ? false : (seen.add(comment.id), true)))];
}

export function editThreadComment<T extends { id: string; body: string }>(comments: readonly T[], commentId: string, body: string): T[] {
  return comments.map((comment) => (comment.id === commentId ? { ...comment, body } : comment));
}

/** Marker-only bodies are empty (HTML comments a host adds), otherwise the trimmed text. */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

// ---- What sits under each diff line ----

export interface PendingReviewComment {
  id: string;
  path: string;
  oldPath?: string;
  position: ReviewPosition;
  startPosition?: ReviewPosition;
  body: string;
}

export interface ReviewDraft extends ReviewAnchor {}

export interface ReviewLineGroup {
  /** The DiffAnnotation id: one per diff line. */
  id: string;
  side: DiffViewSide;
  index: number;
  threads: ReviewThread[];
  pending: PendingReviewComment[];
  draft: boolean;
}

export function groupId(side: DiffViewSide, index: number): string {
  return `review:${side}:${index}`;
}

/** Threads, pending comments and the open draft, gathered under the line each is shown on. Threads the patch does not show are returned apart. */
export function groupReviewLines(input: {
  lines: ReviewPatchLine[];
  threads: readonly ReviewThread[];
  pending: readonly PendingReviewComment[];
  draft: ReviewDraft | null;
  /** Commit diffs use other line numbers; every thread is then unplaced. */
  placeThreads?: boolean;
}): { groups: ReviewLineGroup[]; unplaced: ReviewThread[] } {
  const groups = new Map<string, ReviewLineGroup>();
  const unplaced: ReviewThread[] = [];
  const at = (side: DiffViewSide, index: number) => {
    const id = groupId(side, index);
    let group = groups.get(id);
    if (!group) { group = { id, side, index, threads: [], pending: [], draft: false }; groups.set(id, group); }
    return group;
  };
  for (const thread of input.threads) {
    const where = input.placeThreads === false ? null : viewLineFor(input.lines, thread.path, thread.line, thread.side);
    if (where) at(where.side, where.index).threads.push(thread);
    else unplaced.push(thread);
  }
  for (const comment of input.pending) {
    const anchor = positionAnchor(comment.position);
    const where = viewLineFor(input.lines, comment.path, anchor.line, anchor.side);
    if (where) at(where.side, where.index).pending.push(comment);
  }
  if (input.draft) at(input.draft.side, input.draft.endIndex).draft = true;
  return { groups: [...groups.values()].sort((a, b) => a.index - b.index), unplaced };
}

// ---- Permissions (pullRequestEditing.ts canEditPullRequestComment / canResolvePullRequestThread) ----

const sameLogin = (left: string | undefined, right: string | undefined) => !!left && !!right && left.toLowerCase() === right.toLowerCase();

/** Hosts do not support rewriting review summaries through comment mutations. */
export function canEditPullRequestComment(
  detail: { viewer: string; capabilities: { editComment?: boolean } },
  comment: { author: { login: string } | null; kind: string; canEdit: boolean | undefined },
): boolean {
  if (detail.capabilities.editComment !== true) return false;
  if (comment.kind !== "issue-comment" && comment.kind !== "review-comment") return false;
  if (comment.canEdit !== undefined) return comment.canEdit;
  return sameLogin(detail.viewer, comment.author?.login);
}

export function canResolvePullRequestThread(detail: { permissions: { resolve?: boolean } }, thread: { canResolve: boolean | undefined }): boolean {
  return detail.permissions.resolve !== false && thread.canResolve !== false;
}
