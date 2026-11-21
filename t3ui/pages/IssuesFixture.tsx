// Fixture for testing Issues page, IssueDetailPanel, IssueSavedViewsMenu, and IssueTrackerSettings (#19259, #19274, #39536).
import { mount, signal, View } from "nsh";
import { Issues } from "./Issues";
import { IssueTrackerSettings } from "./settings/IssueTrackerSettings";
import { configureSettingsSync } from "./settings/settingsSync";
import { PRIMARY_ROUTING_ENVIRONMENT } from "../components/pullRequest/pullRequestRoutingInstall";

const rpcLog = signal<string[]>([]);
const viewMode = signal<"issues" | "trackers">("issues");
const envBOffline = signal(true);

const issueBody = signal("Initial description for ENG-101");
const issueTitle = signal("Native Linear sync");
const issueState = signal<{ category: "open" | "closed"; name: string }>({ category: "open", name: "In Progress" });
const issueComments = signal([
  { id: "c1", author: { login: "bob", name: "Bob", avatarUrl: null }, body: "Looking into it", createdAt: "2026-01-01T02:00:00Z", url: null, reactions: [] },
]);

const trackerState = signal({
  trackers: [
    {
      tracker: "linear",
      displayName: "Linear",
      scopeNoun: "team",
      credential: { label: "API key", helpUrl: "https://linear.app/settings/api" },
      connected: false,
      account: null as string | null,
      workspace: null as string | null,
      detail: null as string | null,
      scopes: [{ key: "ENG", name: "Engineering" }],
    },
  ],
  bindings: {} as Record<string, { tracker: string; scope: string }>,
});

async function handleRequest(method: string, payload: unknown): Promise<unknown> {
  rpcLog.update((items) => [...items, `${method}:${JSON.stringify(payload)}`]);
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "issues.list": {
      if (p.projectIds && Array.isArray(p.projectIds) && p.projectIds.length === 0) {
        return { viewers: {}, trackers: [], entries: [], errors: [], nextCursors: {} };
      }
      if (p.host === "env-b-only" && envBOffline()) {
        throw new Error("env-b unreachable");
      }
      return {
        viewers: { "linear.app": "alice@co", "github.com": "alice" },
        trackers: [
          {
            tracker: "linear",
            host: "linear.app",
            projectCount: 1,
            configured: true,
            detail: null,
            capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: false, templates: false, linkedPullRequests: false, events: false, search: true },
          },
          {
            tracker: "github",
            host: "github.com",
            projectCount: 1,
            configured: true,
            detail: null,
            capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: true, templates: false, linkedPullRequests: true, events: true, search: true },
          },
        ],
        entries: [
          {
            tracker: "linear",
            host: "linear.app",
            scope: "ENG",
            key: "ENG-101",
            displayKey: "ENG-101",
            title: issueTitle(),
            url: "https://linear.app/acme/issue/ENG-101",
            author: { login: "alice", name: "Alice", avatarUrl: null },
            state: issueState(),
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-03T00:00:00Z",
            closedAt: null,
            assignees: [],
            labels: [{ name: "parity", color: "0e8a16" }],
            commentCount: issueComments().length,
            projectId: "proj-1",
            projectTitle: "R3 Code",
          },
          {
            tracker: "github",
            host: "github.com",
            scope: "acme/app",
            key: "42",
            displayKey: "#42",
            title: "Verify PR diff",
            url: "https://github.com/acme/app/issues/42",
            author: { login: "bob", name: "Bob", avatarUrl: null },
            state: { category: "open", name: "Open" },
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            closedAt: null,
            assignees: [],
            labels: [],
            commentCount: 0,
            projectId: "proj-1",
            projectTitle: "R3 Code",
          },
        ],
        errors: [],
        nextCursors: {},
        scopes: [{ projectId: "proj-1", tracker: "linear", host: "linear.app", scope: "ENG" }],
      };
    }
    case "issues.detail":
      return {
        tracker: "linear",
        host: "linear.app",
        scope: "ENG",
        key: String(p.key ?? "ENG-101"),
        displayKey: String(p.key ?? "ENG-101"),
        title: issueTitle(),
        url: "https://linear.app/acme/issue/ENG-101",
        author: { login: "alice", name: "Alice", avatarUrl: null },
        state: issueState(),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        closedAt: null,
        assignees: [],
        labels: [{ name: "parity", color: "0e8a16" }],
        commentCount: issueComments().length,
        projectId: "proj-1",
        projectTitle: "R3 Code",
        writable: true,
        capabilities: { create: true, edit: true, comment: true, labels: true, assignees: true, reactions: true, templates: false, linkedPullRequests: true, events: true, search: true },
        viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
        states: [{ category: "open", name: "In Progress" }, { category: "closed", name: "Done" }],
        viewer: "alice",
        body: issueBody(),
        reactions: [],
        comments: issueComments(),
        commentsCursor: null,
        events: [{ id: "e1", kind: "labeled", actor: { login: "alice", name: "Alice", avatarUrl: null }, createdAt: "2026-01-01T01:00:00Z", detail: "parity" }],
        linkedPullRequests: [],
      };
    case "issues.candidates":
      return {
        labels: [{ name: "parity", color: "0e8a16", description: null }],
        assignees: [{ id: "u1", login: "alice", name: "Alice", avatarUrl: null }],
        truncated: false,
      };
    case "issues.comment": {
      const next = [...issueComments(), { id: `c${issueComments().length + 1}`, author: { login: "alice", name: "Alice", avatarUrl: null }, body: String(p.body ?? ""), createdAt: "2026-01-03T01:00:00Z", url: null, reactions: [] }];
      issueComments.set(next);
      return await handleRequest("issues.detail", p);
    }
    case "issues.setState": {
      issueState.set({ category: p.state === "Done" ? "closed" : "open", name: String(p.state ?? "In Progress") });
      return await handleRequest("issues.detail", p);
    }
    case "issueTrackers.list":
      return trackerState();
    case "issueTrackers.connect": {
      const cur = trackerState();
      trackerState.set({
        ...cur,
        trackers: cur.trackers.map((t) =>
          t.tracker === "linear"
            ? { ...t, connected: Boolean(p.token), account: p.token ? "alice@co" : null, workspace: p.token ? "acme" : null }
            : t,
        ),
      });
      return trackerState();
    }
    case "issueTrackers.bindProject": {
      const cur = trackerState();
      const nextBindings = { ...cur.bindings };
      const b = (p.binding as { tracker?: string; scope?: string } | null | undefined);
      if (b?.tracker && b?.scope) {
        nextBindings[String(p.projectId)] = { tracker: b.tracker, scope: b.scope };
      } else {
        delete nextBindings[String(p.projectId)];
      }
      trackerState.set({ ...cur, bindings: nextBindings });
      return trackerState();
    }
    default:
      return {};
  }
}

configureSettingsSync({
  connected: () => true,
  request: handleRequest,
});

mount(() => (
  <View class="h-full w-full flex-col bg-background">
    <View class="h-8 flex-row items-center gap-2 border-b border-border px-3">
      <View role="button" accessibilityLabel="Show issues view" onPress={() => viewMode.set("issues")}>
        <View />
      </View>
      <View role="button" accessibilityLabel="Show trackers view" onPress={() => viewMode.set("trackers")}>
        <View />
      </View>
    </View>
    {viewMode() === "issues" ? (
      <Issues
        deps={{
          status: () => "connected",
          supported: () => true,
          environmentIds: () => [PRIMARY_ROUTING_ENVIRONMENT],
          projects: () => [{ id: "proj-1", title: "R3 Code", environmentId: PRIMARY_ROUTING_ENVIRONMENT }],
          threads: () => [{ id: "t1", title: "Sync Issues", projectId: "proj-1", updatedAt: 100 }],
          projectName: () => "R3 Code",
          request: handleRequest,
          onBack: () => {},
          onOpenSettings: () => viewMode.set("trackers"),
          onOpenThread: () => {},
          onOpenHost: () => {},
        }}
      />
    ) : (
      <View class="flex-1 p-4">
        <IssueTrackerSettings
          environmentId={() => PRIMARY_ROUTING_ENVIRONMENT}
          connected={() => true}
          projects={() => [{ id: "proj-1", name: "R3 Code" }]}
          request={handleRequest}
        />
      </View>
    )}
  </View>
));
