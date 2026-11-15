// The sidebar over server thread shells, fed through the store's real ingestion path (not hand-built view models).
import { expect, test } from "nsh/test";
import { applyShellEventForTest, updateSetting } from "../../store";
import { withOptimisticWorking } from "./optimisticWorking";
import { threadById } from "../../store";
import { resolveThreadStatus, statusDurationLabel } from "./threadStatus";
import { folderThreads, keepsEmptyFolder, sidebarSections } from "./sidebarModel";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const shell = (over: Record<string, unknown> = {}) => ({
  id: "thread-1", projectId: "project-1", title: "Idle thread", status: "idle",
  createdAt: "2026-11-11T11:00:00Z", updatedAt: "2026-11-11T11:30:00Z", latestUserMessageAt: "2026-11-11T11:30:00Z", ...over,
});
const snapshot = (threads: Record<string, unknown>[]) => applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads },
});

test("by default one project with one idle server thread is a flat card, with no folder", () => {
  updateSetting("boringSidebarEnabled", false);
  snapshot([shell()]);
  const sections = sidebarSections(NOW);
  expect(sections.projects).toEqual([]);
  expect(sections.loose.map((thread) => thread.id)).toEqual(["thread-1"]);
  expect(sections.settled).toEqual([]);
});

test("boringSidebarEnabled groups the same server thread under its project folder", () => {
  updateSetting("boringSidebarEnabled", true);
  snapshot([shell()]);
  const sections = sidebarSections(NOW);
  expect(sections.loose).toEqual([]);
  expect(sections.projects.map((project) => project.name)).toEqual(["legion"]);
  expect(folderThreads(sections.projects[0], NOW).map((thread) => thread.id)).toEqual(["thread-1"]);
  updateSetting("boringSidebarEnabled", false);
});

test("a running server thread moves to the Working shelf in the default layout", () => {
  updateSetting("boringSidebarEnabled", false);
  snapshot([shell({ status: "running", latestRunId: "run-1", activeRunId: "run-1", activityRunStatus: "running", activityRunStartedAt: "2026-11-11T11:59:00Z" })]);
  expect(sidebarSections(NOW).working.map((thread) => thread.id)).toEqual(["thread-1"]);
});

test("a server thread mid-send reads Working with a live duration before its shell reports the run", () => {
  updateSetting("boringSidebarEnabled", false);
  snapshot([shell()]);
  const idle = threadById("thread-1")!;
  expect(resolveThreadStatus(idle)).toBe("ready");
  const [sending] = withOptimisticWorking([idle], NOW, ["thread-1"]);
  expect(resolveThreadStatus(sending)).toBe("working");
  expect(statusDurationLabel(sending, NOW + 12_000)).toBe("12s");
  const [after] = withOptimisticWorking([idle], NOW + 5_000, []);
  expect(resolveThreadStatus(after)).toBe("ready");
});

const lineage = (over: Record<string, unknown> = {}) => ({ parentThreadId: null, relationshipToParent: null, rootThreadId: null, sideChat: false, ...over });
const eight = () => Array.from({ length: 8 }, (_, index) => shell({
  id: `thread-${index + 1}`, title: `Thread ${index + 1}`, lineage: lineage(),
  createdAt: `2026-11-11T10:0${index}:00Z`, updatedAt: `2026-11-11T11:${10 + index}:00Z`, latestUserMessageAt: `2026-11-11T11:${10 + index}:00Z`,
  latestRunId: "r", activeRunId: null, latestRunCompletedAt: `2026-11-11T11:${10 + index}:30Z`, settledOverride: null, settledAt: null, archivedAt: null,
}));

test("a contract-shaped snapshot of 8 threads lists all 8 as flat cards, and the open one does not hide the rest", () => {
  updateSetting("boringSidebarEnabled", false);
  snapshot(eight());
  const sections = sidebarSections(NOW);
  expect(sections.projects).toEqual([]);
  expect(sections.loose.length + sections.working.length).toBe(8);
  expect(sections.settled).toEqual([]);
});

test("boring folders list all 8 threads under the one project", () => {
  updateSetting("boringSidebarEnabled", true);
  snapshot(eight());
  expect(folderThreads(sidebarSections(NOW).projects[0], NOW).length).toBe(8);
  updateSetting("boringSidebarEnabled", false);
});

test("subagents and side chats never get their own row, and a child's approval flags its parent", () => {
  updateSetting("boringSidebarEnabled", false);
  snapshot([
    ...eight().slice(0, 2),
    shell({ id: "child", title: "Child", lineage: lineage({ parentThreadId: "thread-1", relationshipToParent: "subagent", rootThreadId: "thread-1" }),
      status: "running", activityRunStatus: "running", latestRunId: "r2", activeRunId: "r2", pendingRuntimeRequest: { kind: "approval" } }),
    shell({ id: "chat", title: "Side", lineage: lineage({ parentThreadId: "thread-2", sideChat: true }) }),
  ]);
  const ids = [...sidebarSections(NOW).loose, ...sidebarSections(NOW).working].map((thread) => thread.id).sort();
  expect(ids).toEqual(["thread-1", "thread-2"]);
});

test("a parent whose live subagent asks for approval leaves the Working shelf", () => {
  updateSetting("boringSidebarEnabled", false);
  const run = { latestRunId: "r", activeRunId: "r", activityRunStatus: "running", status: "running" };
  snapshot([
    shell({ id: "parent", title: "Parent", lineage: lineage(), ...run }),
    shell({ id: "kid", title: "Kid", lineage: lineage({ parentThreadId: "parent", relationshipToParent: "subagent" }), ...run, pendingRuntimeRequest: { kind: "approval" } }),
  ]);
  const sections = sidebarSections(NOW);
  expect(sections.working).toEqual([]);
  expect(sections.loose.map((thread) => thread.id)).toEqual(["parent"]);
});

test("boring folders drop a project with no active thread, unless it is pinned or the list is scoped", () => {
  updateSetting("boringSidebarEnabled", true);
  applyShellEventForTest({
    kind: "snapshot",
    snapshot: {
      projects: [
        { id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" },
        { id: "empty", title: "empty", workspaceRoot: "/work/empty", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" },
        { id: "pinned-empty", title: "pinned-empty", workspaceRoot: "/work/pinned", pinnedAt: "2026-11-02T00:00:00Z", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" },
      ],
      threads: [shell()],
    },
  });
  const names = sidebarSections(NOW).projects.map((project) => project.name).sort();
  expect(names).toEqual(["legion", "pinned-empty"]);
  expect(keepsEmptyFolder({ pinned: false }, ["empty"], 0)).toBe(true);
  expect(keepsEmptyFolder({ pinned: false }, [], 0)).toBe(false);
  updateSetting("boringSidebarEnabled", false);
});
