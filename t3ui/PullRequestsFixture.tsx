// Mounts the Pull requests page on a fake server so tests read what it paints and sends.
import { mount, signal, Text, View } from "nsh";
import { ToastHost } from "./components/toast";
import { CommandPalette } from "./components/CommandPalette";
import { PullRequestsPage } from "./pages/PullRequests";
import { replaceServerSettings } from "./pages/settings/settingsState";
import { speedMode } from "./components/pullRequest/pullRequestSpeed.logic";

replaceServerSettings({ reviewGuidesEnabled: true });

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function entry(number: number, patch: Record<string, unknown>) {
  return {
    provider: "github", host: "github.com", projectId: "p1", projectTitle: "t3code", repository: "acme/t3code", number,
    title: `Pull request ${number}`, url: `https://github.com/acme/t3code/pull/${number}`, author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feature-${number}`, baseBranch: "main", state: "open", isDraft: false, mergeability: "mergeable", additions: 10, deletions: 2,
    createdAt: iso(600), updatedAt: iso(5), viewerReviewRequested: false, labels: [], ...patch,
  };
}

export const requests: { method: string; payload: Record<string, unknown> }[] = [];
const mode = signal<"ok" | "empty" | "fail">("ok");
const lastMutation = signal("");
const toastTitle = signal("");
const lastQuery = signal("");
const noInline = signal(false);
const heldWorkflows = signal(0);
const failNext = signal(false);
const maintainerEdits = signal(false);
let observed = 1;
const detailActions = () => ["merge", "ready", "draft", "close", "update-branch", "enable-auto-merge", ...(heldWorkflows() > 0 ? ["approve-workflows"] : [])];
const optionsAsked = signal("");
const threadDeps = {
  all: () => [{ id: "thread:a", title: "Fix the race", projectId: "p1", updatedAt: 2 }, { id: "thread:b", title: "Unrelated chat", projectId: "p1", updatedAt: 1 }],
  projectName: () => "t3code",
  open: (threadId: string) => lastMutation.set(`open ${threadId}`),
};
const checkoutDeps = {
  projectPath: (projectId: string) => (projectId === "p1" ? "/repo" : null),
  newThread: () => "thread:new",
  selectWorkspace: (workspace: unknown) => lastMutation.set(`workspace ${JSON.stringify(workspace)}`),
  toasts: {
    show: (input: { title: string }) => { toastTitle.set(input.title); return "toast:1"; },
    update: (_id: string, input: { title: string }) => toastTitle.set(input.title),
  },
};

const PATCH = [
  "diff --git a/src/race.ts b/src/race.ts", "--- a/src/race.ts", "+++ b/src/race.ts", "@@ -1,2 +1,2 @@", " keep", "-old line", "+fixed line",
  "diff --git a/src/race.test.ts b/src/race.test.ts", "--- a/src/race.test.ts", "+++ b/src/race.test.ts", "@@ -1 +1 @@", "-a", "+b", "",
].join("\n");
export const diffCalls: { url: string; auth: string }[] = [];
const http = {
  endpoint: () => "ws://127.0.0.1:3773",
  bearer: () => "fixture-token",
  fetch: (async (url: string, init: { headers: Record<string, string> }) => {
    diffCalls.push({ url, auth: init.headers.authorization ?? "" });
    return { ok: true, status: 200, json: async () => ({ patch: PATCH, truncated: false, nextCursor: null }) };
  }) as unknown as typeof fetch,
};

const viewedFiles = new Map<string, string>();

async function request(method: string, payload: unknown) {
  requests.push({ method, payload: payload as Record<string, unknown> });
  if (method === "pullRequests.update" && typeof (payload as { maintainerCanModify?: unknown }).maintainerCanModify === "boolean") {
    lastMutation.set(`${method} ${JSON.stringify(payload)}`);
    if (failNext()) { failNext.set(false); throw new Error("host refused"); }
    maintainerEdits.set((payload as { maintainerCanModify: boolean }).maintainerCanModify);
    return undefined;
  }
  if (method.startsWith("pullRequests.") && ["runAction", "comment", "submitReview", "setLabels", "update", "requestReviewers", "replyToThread", "setThreadResolution", "setReaction", "updateComment"].includes(method.slice(13))) {
    lastMutation.set(`${method} ${JSON.stringify(payload)}`);
    return undefined;
  }
  if (method === "pullRequests.linkedThreads") return { threads: [{ id: "thread:a", projectId: "p1", title: "Fix the race", archivedAt: null }, { id: "thread:old", projectId: "p1", title: "Archived one", archivedAt: "2026-01-01T00:00:00.000Z" }] };
  if (method === "orchestration.dispatchCommand") {
    const { commandId: _commandId, ...command } = payload as Record<string, unknown>;
    lastMutation.set(`${method} ${JSON.stringify(command)}`);
    return undefined;
  }
  if (method === "git.preparePullRequestThread") {
    lastMutation.set(`${method} ${JSON.stringify(payload)}`);
    return { pullRequest: { number: 1 }, branch: "feature-1", worktreePath: (payload as { mode: string }).mode === "worktree" ? "/wt/feature-1" : null, isOnPullRequestHead: true };
  }
  if (method === "pullRequests.filterOptions") {
    const input = payload as { kind: string; query?: string; sigil?: string };
    optionsAsked.set(`options ${input.kind} ${input.sigil ?? ""} ${input.query ?? ""}`.replace(/\s+/gu, " ").trim());
    return { labels: [], truncated: false, authors: [{ login: "octocat", name: "The Octocat", avatarUrl: null }, { login: "mona", name: "Mona Lisa", avatarUrl: null }], references: [{ reference: "#41", kind: "issue", number: 41, title: "Crash on start", state: "open" }, { reference: "#42", kind: "change-request", number: 42, title: "Fix the crash", state: "merged" }] };
  }
  if (method === "pullRequests.labelCandidates") return { candidates: [{ name: "bug", color: "d73a4a", description: null, isApplied: true }, { name: "docs", color: "0075ca", description: null, isApplied: false }], truncated: false };
  if (method === "pullRequests.reviewerCandidates") return { candidates: [{ id: "u1", kind: "user", login: "hubot", name: null, avatarUrl: null, isRequested: true }, { id: "u2", kind: "user", login: "mona", name: "Mona Lisa", avatarUrl: null, isRequested: false }, { id: "t1", kind: "team", login: "core", name: null, avatarUrl: null, isRequested: false }], truncated: true };
  if (method === "pullRequests.stack") return { id: "s1", number: 1, url: "https://github.com/acme/t3code/pull/1", base: "main", layers: [{ number: 1, title: "Pull request 1", headBranch: "feature-1", state: "open" }, { number: 5, title: "Follow-up layer", headBranch: "feature-5", state: "open" }] };
  if (method === "pullRequests.reviewGuide") return { guide: null, run: null, currentHeadSha: "abc" };
  if (method === "pullRequests.generateReviewGuide") {
    return { guide: { headSha: "abc", generatedAt: iso(1), stops: [
      { title: "The race", summary: "Where the lock was missing.", attention: { kind: "risk", note: "Check the unlock path." }, excerpts: [{ path: "src/race.ts", side: "new", start: 2, end: 2, caption: "The new guard" }], files: [], notes: [], questions: ["Is the lock re-entrant?"] },
      { title: "The tests", summary: "Coverage for it.", attention: null, excerpts: [], files: [{ path: "src/race.test.ts", note: "New case" }], notes: [], questions: [] },
    ] }, run: null, currentHeadSha: "abc" };
  }
  if (method === "pullRequests.threadComments") return { comments: [{ id: "rc3", author: { login: "hubot", name: null, avatarUrl: null }, body: "A third reply", createdAt: iso(30), url: null }], nextCursor: null };
  // The host keeps the ticks: the panel asks again after a write, and the answer must agree with it.
  if (method === "pullRequests.filesViewed") return { files: [...viewedFiles].map(([path, state]) => ({ path, state })), truncated: false };
  if (method === "pullRequests.setFilesViewed") {
    for (const file of (payload as { files: { path: string; viewed: boolean }[] }).files) viewedFiles.set(file.path, file.viewed ? "viewed" : "unviewed");
    return undefined;
  }
  if (method === "pullRequests.detail") {
    return { projectId: "p1", projectTitle: "t3code", repository: "acme/t3code", number: (payload as { number?: number }).number ?? 1, title: `Pull request ${(payload as { number?: number }).number ?? 1}`, body: "## Summary\n\nFixes the race.\n\n- one\n- two", url: "https://github.com/acme/t3code/pull/1", state: "open", isDraft: false, mergeability: (payload as { number?: number }).number === 5 ? "conflicting" : "mergeable", additions: 10, deletions: 2, changedFiles: 3, headBranch: "feature-1", baseBranch: "main", createdAt: iso(600), updatedAt: iso(5), mergedAt: null, closedAt: null, author: { login: "octocat", name: null, avatarUrl: null }, reviewers: [{ login: "hubot", name: null, avatarUrl: null }], labels: [{ name: "bug", color: "d73a4a" }], checks: [{ name: "build", status: "success", description: null, url: null, required: true }, { name: "lint", status: "failure", description: null, url: "https://ci/lint", required: false }], headSha: "abc", capabilities: { diff: true, viewedFiles: "host", stacks: true, comment: true, mentions: true, referenceSigils: ["#"], actions: detailActions(), mergeMethods: ["merge", "squash"], updateMethods: ["merge", "rebase"], review: { inlineComment: !noInline(), rangeComment: true, reply: true, resolve: true, verdicts: ["comment", "approve", "request-changes"] }, reactions: true, edit: { changeRequest: true, comment: true, maintainerEdits: true }, reviewers: { request: true, listCandidates: true } }, viewer: "octocat", viewerPermissions: { maintainerEdits: true, resolve: true, updateMethods: ["rebase"], actions: detailActions(), comment: true, verdicts: ["comment", "approve", "request-changes"], labels: true, requestReviewers: true }, mergeCapabilities: { merge: true, squash: true, rebase: false }, autoMergeEnabled: false, baseComparison: "behind", behindBy: 2, workflowApprovalsRequired: heldWorkflows(), maintainerCanModify: maintainerEdits(), observedAt: observed++ };
  }
  if (method === "pullRequests.activity") {
    return { comments: [{ id: "c1", kind: "issue-comment", author: { login: "hubot", name: null, avatarUrl: null }, body: "Looks good", createdAt: iso(60), url: null, path: null, reviewState: null }, { id: "c2", kind: "issue-comment", author: { login: "octocat", name: null, avatarUrl: null }, body: "My own **note**", createdAt: iso(30), url: null, path: null, reviewState: null }], reactions: [{ content: "heart", count: 2, actors: ["a", "b"], viewerHasReacted: false }], commentCount: 2, commentsTruncated: false, reviewThreads: [{ id: "t1", path: "src/race.ts", line: 2, side: "right", isResolved: false, isOutdated: false, commentCount: 3, nextCommentsCursor: "c2", comments: [{ id: "rc1", author: { login: "hubot", name: null, avatarUrl: null }, body: "Is this guard enough?", createdAt: iso(50), url: null, reactions: [{ content: "thumbs-up", count: 1, actors: ["octocat"], viewerHasReacted: false }], canEdit: false }, { id: "rc2", author: { login: "octocat", name: null, avatarUrl: null }, body: "Yes, the lock covers it.", createdAt: iso(40), url: null, canEdit: true }] }, { id: "t2", path: "src/gone.ts", line: 4, side: "right", isResolved: false, isOutdated: true, comments: [{ id: "rc9", author: { login: "hubot", name: null, avatarUrl: null }, body: "Outdated remark", createdAt: iso(500), url: null }] }], commits: [{ oid: "abcdef1234567", messageHeadline: "Fix the race", committedDate: iso(120), authors: [] }] };
  }
  if (mode() === "fail") throw new Error("host unreachable");
  if (mode() === "empty") return { viewers: {}, providers: [], entries: [], errors: [], truncated: false, nextCursors: {} };
  const cursors = payload as { cursors?: Record<string, string>; state?: string };
  // The host's own answers for the partitions: older rows the recency-ordered main page does not hold.
  const involvement = (payload as { involvement?: string }).involvement;
  if ((payload as { projectId?: string }).projectId === "p2") return { viewers: { "github.com": "octocat" }, providers: [], entries: [entry(21, { projectId: "p2", projectTitle: "docs-site", repository: "acme/docs", title: "Docs page" })], errors: [], truncated: false, nextCursors: {} };
  if (involvement === "authored") return { viewers: { "github.com": "octocat" }, providers: [], entries: [entry(1, { checksState: "", reviewDecision: "approved" }), entry(11, { title: "Older authored work" })], errors: [], truncated: false, nextCursors: {} };
  if (involvement === "reviewing") return { viewers: { "github.com": "octocat" }, providers: [], entries: [entry(2, { author: { login: "hubot", name: null, avatarUrl: null }, viewerReviewRequested: true, title: "Needs my review" }), entry(12, { title: "Older review request", author: { login: "mona", name: null, avatarUrl: null }, viewerReviewRequested: true })], errors: [], truncated: false, nextCursors: {} };
  if (cursors.cursors) return { viewers: { "github.com": "octocat" }, providers: [], entries: [entry(9, { title: "Second page" })], errors: [], truncated: false, nextCursors: {} };
  const asked = (payload as { query?: string }).query;
  lastQuery.set(asked ?? "");
  if (asked === "inthebody") return { viewers: { "github.com": "octocat" }, providers: [{ host: "github.com", kind: "github", searchesOnHost: true, configured: true, detail: null, actions: [] }], entries: [entry(7, { title: "Unrelated title" })], errors: [], truncated: false, nextCursors: {} };
  const hostAnswer = <T extends { title: string }>(rows: T[]) => (asked ? rows.filter((row) => row.title.toLowerCase().includes(asked.toLowerCase())) : rows);
  return {
    viewers: { "github.com": "octocat" }, providers: [{ host: "github.com", kind: "github", searchesOnHost: true, configured: true, detail: null, actions: ["close", "merge", "ready", "reopen"] }],
    // The host searches its own text, so only matching rows come back.
    entries: hostAnswer([
      entry(1, { checksState: "", reviewDecision: "approved", labels: [{ name: "bug", color: "d73a4a" }] }),
      entry(2, { author: { login: "hubot", name: null, avatarUrl: null }, viewerReviewRequested: true, checksState: "failing", title: "Needs my review" }),
      entry(3, { author: { login: "mona", name: null, avatarUrl: null }, isDraft: true, title: "Draft work" }),
      entry(4, { state: "merged", title: "Already merged", author: { login: "mona", name: null, avatarUrl: null } }),
    ]),
    errors: [], truncated: true, nextCursors: { "acme/t3code": "page2" },
  };
}

mount(() => (
  <View class="flex-1 flex-row bg-background">
    <PullRequestsPage request={request} status={() => "connected"} hasProjects={() => true} projects={() => [{ id: "p1", title: "t3code" }, { id: "p2", title: "docs-site" }]} debounceMs={0} http={http} checkout={checkoutDeps} threadLinksSupported={() => true} threads={threadDeps} setDraft={(text) => lastMutation.set(`draft ${text.replaceAll("\n", " ")}`)} />
    <ToastHost />
    <CommandPalette />
    <View class="absolute bottom-0 left-0"><Text class="text-2xs">{lastMutation()}</Text></View>
    <View class="absolute left-0 top-0"><Text class="text-2xs">{toastTitle()}</Text></View>
    <View class="absolute right-24 top-0"><Text class="text-2xs">{optionsAsked()}</Text></View>
    <View class="absolute right-0 top-0"><Text class="text-2xs">{lastQuery() ? `asked:${lastQuery()}` : ""}</Text></View>
    <View class="absolute bottom-0 right-0 flex-row gap-2">
      <View accessibilityLabel="Hold shift" onPress={() => speedMode.set(true)} class="h-6 w-24"><Text class="text-xs">shift</Text></View>
      <View accessibilityLabel="Disable inline comments" onPress={() => noInline.set(true)} class="h-6 w-24"><Text class="text-xs">no inline</Text></View>
      <View accessibilityLabel="Hold workflows" onPress={() => heldWorkflows.set(2)} class="h-6 w-24"><Text class="text-xs">hold</Text></View>
      <View accessibilityLabel="Fail the next save" onPress={() => failNext.set(true)} class="h-6 w-24"><Text class="text-xs">failsave</Text></View>
      <View accessibilityLabel="Fail the server" onPress={() => mode.set("fail")} class="h-6 w-24"><Text class="text-xs">fail</Text></View>
      <View accessibilityLabel="Empty the server" onPress={() => mode.set("empty")} class="h-6 w-24"><Text class="text-xs">empty</Text></View>
    </View>
  </View>
));

