import { expect, test } from "nsh/test";
import type { ScheduledTask } from "../scheduled/data";
import {
  boundTasks, contextTone, limitTone, lineageWindow, lockedWorkspaceLabel, otherPullRequests, pullRequestRowLabel, pullRequestTone, readDiscoveredServers,
  readEnvironmentDescriptor, relationshipRows, relativeUpcoming, runContextLabel, serverCaption, showMoreLabel, taskScheduleLine, threadServers, workspaceIconName, workspaceMarkName,
} from "./detailsLogic";

test("a started thread's workspace row names a worktree or the local checkout", () => {
  expect(lockedWorkspaceLabel("/repo/.worktrees/x")).toBe("Worktree");
  expect(lockedWorkspaceLabel(undefined)).toBe("Local checkout");
  expect(workspaceIconName("/w")).toBe("folder-git-2");
  expect(workspaceIconName(null)).toBe("folder");
});

test("pull request rows read #N: title, tone from the snapshot, and the others wait behind Show N more", () => {
  const link = (number: number, state?: string, isDraft = false) => ({
    host: "github.com", repository: "o/r", number, url: `u${number}`, source: "manual", linkedAt: "t",
    snapshot: state ? { state, title: `T${number}`, isDraft, headBranch: "h", baseBranch: "b", additions: 0, deletions: 0, changedFiles: 0, checksState: null, reviewDecision: null } : null,
    watching: false,
  });
  expect(pullRequestRowLabel(link(5, "open"))).toBe("#5: T5");
  expect(pullRequestRowLabel(link(5))).toBe("#5");
  expect(pullRequestTone(link(1, "merged"))).toBe("merged");
  expect(pullRequestTone(link(1, "open", true))).toBe("draft");
  expect(pullRequestTone(link(1))).toBe("open");
  const all = [link(3, "open"), link(2, "merged"), link(1, "closed")];
  expect(otherPullRequests(all, all[0]!).map((item) => item.number)).toEqual([2, 1]);
  expect(otherPullRequests(all, null)).toEqual([]);
  expect(showMoreLabel(false, 2)).toBe("Show 2 more");
  expect(showMoreLabel(true, 2)).toBe("Show less");
});

test("servers are the ones this thread's terminals or agent started", () => {
  const servers = readDiscoveredServers({
    servers: [
      { host: "127.0.0.1", port: 3000, url: "http://localhost:3000", processName: "vite", pid: 11, terminal: { threadId: "t1", terminalId: "term-1" } },
      { host: "127.0.0.1", port: 4000, url: "http://localhost:4000", processName: null, pid: null, terminal: null, agent: { threadId: "t1" } },
      { host: "127.0.0.1", port: 5000, url: "http://localhost:5000", processName: "x", pid: 12, terminal: { threadId: "t2", terminalId: "term-1" } },
      { port: "bad" },
    ],
  });
  expect(servers.length).toBe(3);
  const mine = threadServers(servers, "t1");
  expect(mine.map((server) => server.port)).toEqual([3000, 4000]);
  expect(serverCaption(mine[0]!)).toBe("Terminal · vite");
  expect(serverCaption(mine[1]!)).toBe("Agent");
  expect(threadServers(servers, null)).toEqual([]);
});

test("an automation line says when it runs next, or why it does not", () => {
  const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
    id: "a", title: "Nightly", prompt: "p", enabled: true, schedule: { type: "interval", everyMs: 3_600_000 }, projectId: "p", threadId: "t1",
    workspaceStrategy: {}, modelSelection: {}, runtimeMode: "x", interactionMode: "y", updatedAt: null, nextRunAt: null, lastRunStatus: "never", lastRunError: null, blockedByPolicy: null, ...over,
  });
  const now = Date.parse("2030-01-01T00:00:00Z");
  expect(taskScheduleLine(task({ nextRunAt: "2030-01-01T02:00:00Z" }), now)).toBe("Every 60 min · next in 2h");
  expect(taskScheduleLine(task({ enabled: false }), now)).toBe("Every 60 min · paused");
  expect(taskScheduleLine(task({ blockedByPolicy: "Policy" }), now)).toBe("Every 60 min · Policy");
  expect(relativeUpcoming("2030-01-01T00:10:00Z", now)).toBe("in 10m");
  expect(relativeUpcoming("2030-01-03T00:00:00Z", now)).toBe("in 2d");
  expect(boundTasks([task({}), task({ id: "b", threadId: "t2" })], "t1").map((item) => item.id)).toEqual(["a"]);
});

test("lineage lists the parent, forks and subagents, and side chats apart", () => {
  const threads = [
    { id: "p", title: "Parent" },
    { id: "f", title: "Fork", lineage: { parentThreadId: "me", relationshipToParent: "fork" as const, rootThreadId: "p", sideChat: false } },
    { id: "s", title: "Agent", lineage: { parentThreadId: "me", relationshipToParent: "subagent" as const, rootThreadId: "p", sideChat: false } },
    { id: "c", title: "Aside", lineage: { parentThreadId: "me", relationshipToParent: null, rootThreadId: "p", sideChat: true } },
  ];
  const rows = relationshipRows({ id: "me", lineage: { parentThreadId: "p", relationshipToParent: "fork", rootThreadId: "p", sideChat: false } }, threads);
  expect(rows.related.map((row) => `${row.label}:${row.title}`)).toEqual(["Parent thread:Parent", "Fork:Fork", "Subagent:Agent"]);
  expect(rows.sideChats.map((row) => row.title)).toEqual(["Aside"]);
  const agentRows = relationshipRows({ id: "me", lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: "p", sideChat: false } }, threads);
  expect(agentRows.related[0]?.label).toBe("Parent agent");
  expect(lineageWindow([1, 2, 3, 4, 5, 6, 7], 6)).toEqual({ visibleRows: [1, 2, 3, 4, 5, 6], hiddenCount: 1 });
});

test("context and limit bars turn warning then error as they fill", () => {
  expect(contextTone(null)).toBe(null);
  expect(contextTone(79)).toBe(null);
  expect(contextTone(80)).toBe("warning");
  expect(contextTone(90)).toBe("error");
  expect(limitTone(21)).toBe(null);
  expect(limitTone(20)).toBe("warning");
  expect(limitTone(10)).toBe("error");
});

test("the environment row reads the server's label and machine, and a generic local label reads This device", () => {
  expect(readEnvironmentDescriptor({ environment: { label: "OzBook M3", platform: { machine: "laptop" } } })).toEqual({ label: "OzBook M3", machine: "laptop" });
  expect(readEnvironmentDescriptor({ environment: { label: "Local environment", platform: {} } })).toEqual({ label: "This device", machine: "server" });
  expect(readEnvironmentDescriptor({ environment: { label: "Box", platform: { machine: "laptop" } }, settings: { environmentIcon: "mac-mini" } })?.machine).toBe("mac-mini");
  expect(readEnvironmentDescriptor({})).toBeNull();
  expect(runContextLabel("Local checkout", "OzBook M3")).toBe("Run context: OzBook M3, Local checkout");
  expect(runContextLabel("Worktree")).toBe("Run context: Worktree");
  expect(workspaceMarkName("/w")).toBe("folder-git");
  expect(workspaceMarkName(null)).toBe("folder");
});

test("a Linux environment gets its own filled mark", async () => {
  const { MACHINE_ICON } = await import("./detailsLogic");
  expect(MACHINE_ICON.linux).toBe("linux");
  expect(Object.values(MACHINE_ICON)).not.toContain("square-terminal");
});
