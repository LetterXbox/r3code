// Unit tests for issue contracts parsing, grouping, preferences, Linear links, RightPanel issue surface, and multi-env retry (#19259, #19274, #29387, #37963, #38854, #39536).
import { expect, test } from "nsh/test";
import { readLinkedIssues } from "../header/threadRelations";
import { initialPanelState, openIssueSurface, readPanelState, surfaceTitle } from "../rightPanel/panelLogic";
import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  parseIssueDetail,
  parseIssueListResult,
  parseIssueTrackerConnections,
  parseLinearIssueUrl,
  resolveIssueLinkTarget,
} from "./issueLogic";
import {
  DEFAULT_ISSUE_LIST_PREFERENCES,
  issueViewMatches,
  issueViewNameError,
  readIssueListPreferences,
  readIssueSavedViews,
  writeIssueSavedViews,
} from "./issueListPreferences";
import { createIssueListModel } from "./issueStore";

test("parseIssueListResult, groupIssues, and pagination merge cursors per host (#19259)", () => {
  const firstRaw = {
    viewers: { "github.com": "alice", "linear.app": "alice@co" },
    trackers: [
      { tracker: "github", host: "github.com", projectCount: 1, configured: true, detail: null, capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: true, templates: false, linkedPullRequests: true, events: true, search: true } },
      { tracker: "linear", host: "linear.app", projectCount: 1, configured: true, detail: null, capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: false, templates: false, linkedPullRequests: false, events: false, search: true } },
    ],
    entries: [
      { tracker: "github", host: "github.com", scope: "acme/app", key: "42", displayKey: "#42", title: "Fix login", url: "https://github.com/acme/app/issues/42", author: { login: "alice", name: "Alice", avatarUrl: null }, state: { category: "open", name: "Open" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", closedAt: null, assignees: [], labels: [{ name: "bug", color: "d73a4a" }], commentCount: 2, projectId: "p1", projectTitle: "App" },
      { tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-101", displayKey: "ENG-101", title: "Native sync", url: "https://linear.app/acme/issue/ENG-101", author: null, state: { category: "open", name: "In Progress" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", closedAt: null, assignees: [], labels: [], commentCount: 0, projectId: "p1", projectTitle: "App" },
    ],
    errors: [],
    nextCursors: { "github.com p1": "gh-c2", "linear.app ENG": "lin-c2" },
  };
  const held = holdIssuePages([["primary", parseIssueListResult(firstRaw)]], new Map());
  const page = held.get("primary")!;
  expect(issueCursorsForHost(page.nextCursors, "linear.app")).toEqual({ "linear.app ENG": "lin-c2" });

  const next = continueIssuePage(
    page,
    parseIssueListResult({
      viewers: {},
      trackers: firstRaw.trackers,
      entries: [
        { tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-102", displayKey: "ENG-102", title: "Page 2 item", url: "https://linear.app/acme/issue/ENG-102", author: null, state: { category: "open", name: "Todo" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T12:00:00Z", closedAt: null, assignees: [], labels: [], commentCount: 0, projectId: "p1", projectTitle: "App" },
      ],
      errors: [],
      nextCursors: {},
    }),
    { "linear.app ENG": "lin-c2" },
  );

  const groups = groupIssues(new Map([["primary", next]]), "", [], "updated");
  expect(groups.map((g) => g.tracker.tracker)).toEqual(["github", "linear"]);
  expect(groups[1]!.rows.map((r) => r.displayKey)).toEqual(["ENG-101", "ENG-102"]);
  expect(groups[0]!.more).toEqual(["primary"]);
  expect(groups[1]!.more).toEqual([]);
});

test("Linear issue URL parser and resolveIssueLinkTarget (#38854)", () => {
  expect(parseLinearIssueUrl("https://linear.app/acme/issue/ENG-123/fix-bug")).toEqual({
    host: "linear.app",
    workspace: "acme",
    scope: "ENG",
    key: "ENG-123",
  });
  expect(parseLinearIssueUrl("https://github.com/acme/repo/issues/1")).toBe(null);

  const trackers = parseIssueTrackerConnections({
    trackers: [
      { tracker: "linear", displayName: "Linear", scopeNoun: "team", credential: { label: "API key", helpUrl: null }, connected: true, account: "alice@co", workspace: "acme", detail: null, scopes: [{ key: "ENG", name: "Engineering" }] },
    ],
    bindings: { "proj-1": { tracker: "linear", scope: "ENG" } },
  });

  const resolvedLinear = resolveIssueLinkTarget({
    url: "https://linear.app/acme/issue/ENG-99/some-slug",
    projects: [{ id: "proj-1" }],
    preferredProjectId: "proj-1",
    trackers,
  });
  expect(resolvedLinear).toEqual({
    projectId: "proj-1",
    ref: { projectId: "proj-1", tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-99" },
  });

  const resolvedGitHub = resolveIssueLinkTarget({
    url: "https://github.com/acme/repo/issues/42",
    projects: [{ id: "proj-1" }],
    preferredProjectId: "proj-1",
  });
  expect(resolvedGitHub?.ref).toEqual({ projectId: "proj-1", tracker: "github", host: "github.com", scope: "acme/repo", key: "42" });
});

test("issue list preferences and saved views (#37963, #38799)", () => {
  expect(readIssueListPreferences("{bad json")).toEqual(DEFAULT_ISSUE_LIST_PREFERENCES);
  const parsed = readIssueListPreferences(JSON.stringify({ who: "assigned", status: "closed", label: ["bug", "p1"], assignee: "alice", order: "created", q: "sync" }));
  expect(parsed).toEqual({ who: "assigned", status: "closed", label: ["bug", "p1"], assignee: "alice", order: "created", q: "sync" });

  const views = readIssueSavedViews(writeIssueSavedViews([{ id: "v1", name: "My bugs", preferences: parsed }]));
  expect(views.length).toBe(1);
  expect(issueViewMatches(views[0]!, { ...parsed, label: ["p1", "bug"] })).toBe(true);
  expect(issueViewNameError("my bugs", views)).toBe("A view with this name already exists.");
  expect(issueViewNameError("my bugs", views, "v1")).toBe(null);
});

test("panelLogic opens and restores issue surface & readLinkedIssues parses thread.issues", () => {
  const opened = openIssueSurface(initialPanelState, {
    projectId: "p1",
    tracker: "linear",
    host: "linear.app",
    scope: "ENG",
    key: "ENG-7",
    url: "https://linear.app/acme/issue/ENG-7",
  });
  expect(opened.surfaces.length).toBe(1);
  expect(surfaceTitle(opened.surfaces[0]!)).toBe("ENG-7");
  const restored = readPanelState(opened, 1200);
  expect(restored.surfaces[0]?.kind).toBe("issue");
  expect(restored.surfaces[0]?.key).toBe("ENG-7");

  const linked = readLinkedIssues([
    { tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-7", projectId: "p1", url: "https://linear.app/acme/issue/ENG-7", source: "manual", linkedAt: "2026-01-02T00:00:00Z", displayKey: "ENG-7", title: "Fix" },
  ]);
  expect(linked.length).toBe(1);
  expect(linked[0]!.displayKey).toBe("ENG-7");

  const detail = parseIssueDetail({
    tracker: "github",
    host: "github.com",
    scope: "acme/app",
    key: "42",
    displayKey: "#42",
    title: "Fix",
    url: "https://github.com/acme/app/issues/42",
    author: { login: "alice", name: null, avatarUrl: null },
    state: { category: "open", name: "Open" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 1,
    projectId: "p1",
    projectTitle: "App",
    writable: true,
    capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: true, templates: false, linkedPullRequests: true, events: true, search: true },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    states: [{ category: "open", name: "Open" }, { category: "closed", name: "Closed" }],
    viewer: "alice",
    body: "Hello",
    comments: [{ id: "c1", author: { login: "bob", name: null, avatarUrl: null }, body: "Nice", createdAt: "2026-01-01T01:00:00Z", url: null }],
    commentsCursor: null,
    events: [{ id: "e1", kind: "labeled", actor: { login: "alice", name: null, avatarUrl: null }, createdAt: "2026-01-01T02:00:00Z", detail: "bug" }],
    linkedPullRequests: [],
  });
  expect(detail.comments.length).toBe(1);
  expect(detail.events[0]!.kind).toBe("labeled");
});

test("createIssueListModel retryFailed refetches only failed environments (#39536)", async () => {
  let failEnv2 = true;
  const calls: string[] = [];
  const model = createIssueListModel({
    request: async (_method, payload) => {
      const p = payload as { host?: string };
      calls.push(p.host ?? "unknown");
      if (p.host === "env2" && failEnv2) throw new Error("env2 offline");
      return {
        viewers: {},
        trackers: [{ tracker: "github", host: "github.com", projectCount: 1, configured: true, detail: null, capabilities: null }],
        entries: [
          {
            tracker: "github",
            host: "github.com",
            scope: "acme/app",
            key: p.host === "env2" ? "2" : "1",
            displayKey: p.host === "env2" ? "#2" : "#1",
            title: `From ${p.host}`,
            url: `https://github.com/acme/app/issues/${p.host === "env2" ? "2" : "1"}`,
            author: null,
            state: { category: "open", name: "Open" },
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            closedAt: null,
            assignees: [],
            labels: [],
            commentCount: 0,
            projectId: "p1",
            projectTitle: "App",
          },
        ],
        errors: [],
        nextCursors: {},
      };
    },
  });

  await model.load([
    { environmentId: "env-a", input: { state: "open", involvement: "all", host: "env1" } },
    { environmentId: "env-b", input: { state: "open", involvement: "all", host: "env2" } },
  ]);
  expect(calls).toEqual(["env1", "env2"]);
  expect(model.environmentErrors().size).toBe(1);
  expect(model.entries().map((e) => e.displayKey)).toEqual(["#1"]);

  calls.length = 0;
  failEnv2 = false;
  await model.retryFailed();
  expect(calls).toEqual(["env2"]);
  expect(model.environmentErrors().size).toBe(0);
  expect(model.entries().map((e) => e.displayKey)).toEqual(["#1", "#2"]);
});
