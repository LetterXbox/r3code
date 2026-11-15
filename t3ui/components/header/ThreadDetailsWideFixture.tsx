import { mount, signal, Text, View } from "nsh";
import type { ProjectScript } from "./projectScripts";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";

const log = signal<string[]>([]);
const open = signal(true);
const opened = signal(0);
const scripts = signal<ProjectScript[]>([{ id: "test", name: "Test", command: "bun test", icon: "test", runOnWorktreeCreate: false }]);
let emitAction: (value: unknown) => void = () => {};
let actionId = "";

const subscribe: Subscribe = (method, payload, onValue) => {
  const body = payload as Record<string, unknown>;
  log.update((all) => [...all, `subscribe:${method}:${typeof body.action === "string" ? body.action : ""}${typeof body.action === "string" ? `:${String(body.commitMessage ?? "")}:${JSON.stringify(body.filePaths ?? null)}` : ""}`]);
  if (method === "subscribeDiscoveredLocalServers") {
    onValue({ servers: [{ host: "localhost", port: 3000, url: "http://localhost:3000", processName: "vite", pid: 42, terminal: { threadId: "thread-1", terminalId: "term-1" } }, { host: "localhost", port: 9999, url: "http://localhost:9999", processName: "other", pid: 7, terminal: { threadId: "elsewhere", terminalId: "term-1" } }] });
    return () => {};
  }
  if (method === "scheduledTasks.subscribe") {
    onValue({ tasks: [{ id: "task-1", title: "Nightly sweep", prompt: "p", enabled: true, schedule: { kind: "daily", time: "09:00" }, projectId: "project-1", threadId: "thread-1", workspaceStrategy: {}, modelSelection: {}, runtimeMode: "x", interactionMode: "x", updatedAt: null, nextRunAt: null, lastRunStatus: "never", lastRunError: null, blockedByPolicy: null }] });
    return () => {};
  }
  if (method === "subscribeVcsStatus") {
    onValue({
      _tag: "snapshot",
      local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feature", hasWorkingTreeChanges: true, workingTree: { files: [{ path: "src/a.ts", insertions: 2, deletions: 1 }, { path: "src/b.ts", insertions: 1, deletions: 0 }], insertions: 282452, deletions: 16341 } },
      remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
    });
  } else {
    emitAction = onValue;
    actionId = String(body.actionId);
    // Presses outside the card close it, so the fixture finishes the action on its own.
    setTimeout(() => emitAction({ actionId, kind: "action_finished", result: { toast: { title: "Pushed to origin", cta: { kind: "none" } } } }), 600);
  }
  return () => {};
};
const request: Request = async (method, payload) => {
  log.update((all) => [...all, `request:${method}:${JSON.stringify(payload)}`]);
  if (method === "server.getConfig") return { availableEditors: ["vscode", "zed", "file-manager"], environment: { label: "OzBook M3", platform: { os: "darwin", arch: "arm64", machine: "laptop" }, capabilities: { localServerStop: true } } };
  if (method === "vcs.listRefs") return { refs: [{ name: "feature", current: true, isDefault: false, worktreePath: null }, { name: "main", current: false, isDefault: true, worktreePath: null }, { name: "origin/dev", isRemote: true, remoteName: "origin", current: false, isDefault: false, worktreePath: null }], isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 3 };
  if (method === "projects.mutate") {
    const body = payload as { scripts?: unknown };
    if (Array.isArray(body.scripts)) scripts.set(body.scripts as ProjectScript[]);
  }
  return undefined;
};

mount(() => (
  <View class="flex-1">
    <Text>{log().join("|")}</Text>
    <Text>{`changes opened: ${opened()}`}</Text>
    <View role="button" accessibilityLabel="Toggle card" onPress={() => open.update((value) => !value)}><Text>Toggle card</Text></View>
    <ThreadDetailsCard thread={() => ({ id: "thread-1", title: "Work", relations: { parentThreadId: null, linkOrigin: null, guestShare: null, lineage: { parentThreadId: "parent-1", relationshipToParent: "fork", rootThreadId: "parent-1", sideChat: false }, pullRequests: [{ host: "github.com", repository: "o/r", number: 12, url: "https://github.com/o/r/pull/12", source: "agent", linkedAt: "2026-01-02T00:00:00Z", snapshot: { state: "open", title: "Add thing", isDraft: false, headBranch: "a", baseBranch: "main", additions: 1, deletions: 0, changedFiles: 1, checksState: null, reviewDecision: null }, watching: false }, { host: "github.com", repository: "o/r", number: 9, url: "https://github.com/o/r/pull/9", source: "agent", linkedAt: "2026-01-01T00:00:00Z", snapshot: null, watching: false }] } })} threads={() => [{ id: "parent-1", title: "Parent work", status: "idle" }, { id: "side-1", title: "Quick question", status: "idle", lineage: { parentThreadId: "thread-1", relationshipToParent: null, rootThreadId: "thread-1", sideChat: true } }]} open={open} cwd={() => "/repo"} threadId={() => "thread-1"} onClose={() => open.set(false)} onOpenChanges={() => opened.update((n) => n + 1)} subscribe={subscribe} request={request} scripts={scripts} projectId={() => "project-1"} onRunScript={(script) => log.update((all) => [...all, `run-script:${script.id}`])} />
  </View>
));
