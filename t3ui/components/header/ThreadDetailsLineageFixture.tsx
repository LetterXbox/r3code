// A forked thread whose card shows every Lineage row kind: the delegated-from row, the merge-back split row of the thread it
// forked from, a Claude workflow with phases, and a running app-owned subagent. The server calls are scripted and logged.
import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";
import type { LineageThread } from "./lineageLogic";
import { recordFamilyShellEvent } from "../../environments/familyRemovals";

const log = signal<string[]>([]);
const open = signal(true);
const title = signal("Fork");
let familyVersion = 0;
setTimeout(() => { familyVersion++; recordFamilyShellEvent("", { kind: "snapshot", snapshot: { threads: [], projects: [] } }); }, 2200);
setTimeout(() => title.set("Updated fork"), 1000);
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const threads: LineageThread[] = [
  { id: "source", title: "Plan the work", status: "idle", createdAt: NOW - 7_200_000, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "source", sideChat: false } },
  { id: "wf-thread", title: "Review coordinator", status: "running", createdAt: NOW - 120_000, startedAt: NOW - 120_000, lineage: { parentThreadId: "fork-1", relationshipToParent: "subagent", rootThreadId: "source", sideChat: false } },
  { id: "helper-thread", title: "Helper", status: "running", createdAt: NOW - 60_000, startedAt: NOW - 60_000, lineage: { parentThreadId: "fork-1", relationshipToParent: "subagent", rootThreadId: "source", sideChat: false } },
];

const projection = {
  thread: { lineage: { relationshipToParent: "fork", parentThreadId: "source" }, forkedFrom: { type: "run", threadId: "source" } },
  runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
  providerSessions: [], providerThreads: [],
  subagents: [
    {
      id: "wf-1", threadId: "fork-1", runId: "run-1", origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent", childThreadId: "wf-thread", title: "Review coordinator", status: "running",
      startedAt: iso(NOW - 120_000), completedAt: null, nativeTaskRef: { strength: "strong", nativeId: "task-1" },
      workflow: {
        name: "Parallel review", phases: [{ index: 0, title: "Survey" }],
        agents: [
          { index: 0, label: "Read the diff", state: "completed", phaseIndex: 0, startedAt: NOW - 100_000, completedAt: NOW - 70_000, childThreadId: "c0" },
          { index: 1, label: "Check tests", state: "running", phaseIndex: 0, startedAt: NOW - 60_000 },
        ],
      },
    },
    { id: "sub-1", threadId: "fork-1", runId: "run-1", origin: "app_owned", driver: "codex", providerInstanceId: "codex", childThreadId: "helper-thread", title: "Helper", status: "running", startedAt: iso(NOW - 60_000), completedAt: null, nativeTaskRef: null },
  ],
};

const subscribe: Subscribe = (method, _payload, onValue) => {
  if (method === "subscribeVcsStatus") onValue({ _tag: "snapshot", local: { isRepo: false, hasPrimaryRemote: false, isDefaultRef: false, refName: null, hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } }, remote: null });
  return () => {};
};
const request: Request = async (method, payload) => {
  log.update((all) => [...all, `request:${method}:${JSON.stringify(payload)}`]);
  if (method === "server.getConfig") return { availableEditors: [], environment: { label: "OzBook M3", platform: { os: "darwin", arch: "arm64", machine: "linux" }, capabilities: {} } };
  if (method === "orchestration.getThreadProjection") return projection;
  if (method === "orchestration.getThreadFamily") return { snapshotSequence: familyVersion + 1, threads: [{ id: "omitted-child", projectId: "project-1", title: familyVersion ? "Refreshed helper" : "Earlier helper", status: "completed", createdAt: iso(NOW - 180_000), updatedAt: iso(NOW - 120_000), lineage: { parentThreadId: "fork-1", rootThreadId: "source", relationshipToParent: "subagent" } }] };
  if (method === "orchestration.getThreadTitles") return {};
  return undefined;
};

mount(() => (
  <View class="flex-1">
    <Text>{title()}</Text>
    <Text onPress={() => recordFamilyShellEvent("", { kind: "thread.removed", location: "active", threadId: "omitted-child", sequence: 2 })}>Remove family child</Text>
    <Text>{log().join("|")}</Text>
    <ThreadDetailsCard
      thread={() => ({ id: "fork-1", title: title(), projectId: "project-1", relations: { parentThreadId: null, linkOrigin: "Work Mac", guestShare: null, delegatedFrom: { environmentId: "env-2", threadId: "remote-1", title: "Delegating agent" }, lineage: { parentThreadId: "source", relationshipToParent: "fork", rootThreadId: "source", sideChat: false } } })}
      threads={() => threads}
      open={open}
      cwd={() => "/folder"}
      threadId={() => "fork-1"}
      onClose={() => open.set(false)}
      subscribe={subscribe}
      request={request}
      scripts={() => []}
      projectId={() => "project-1"}
    />
  </View>
));
