// The reference card's state from the owner's side-by-side screenshot: a folder that is no repository, one
// server the agent started, one running child and 46 finished ones. The server calls are scripted.
import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";
import type { LineageThread } from "./lineageLogic";

const log = signal<string[]>([]);
const open = signal(true);
let emitVcs: (value: unknown) => void = () => {};
const snapshot = (isRepo: boolean) => ({ _tag: "snapshot", local: { isRepo, hasPrimaryRemote: false, isDefaultRef: false, refName: isRepo ? "main" : null, hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } }, remote: null });
const NOW = Date.now();

const children: LineageThread[] = [
  { id: "child-running", title: "Fix menus clipped by browser", status: "running", createdAt: NOW - 240_000, startedAt: NOW - 240_000, lineage: { parentThreadId: "thread-1", relationshipToParent: "subagent", rootThreadId: "thread-1", sideChat: false } },
  ...Array.from({ length: 46 }, (_, index): LineageThread => ({ id: `child-${index}`, title: `Earlier agent ${index}`, status: "idle", createdAt: NOW - 3_600_000 - index * 1000, startedAt: NOW - 3_600_000, completedAt: NOW - 3_500_000, lineage: { parentThreadId: "thread-1", relationshipToParent: "subagent", rootThreadId: "thread-1", sideChat: false } })),
];

const subscribe: Subscribe = (method, _payload, onValue) => {
  log.update((all) => [...all, `subscribe:${method}`]);
  if (method === "subscribeDiscoveredLocalServers") {
    onValue({ servers: [{ host: "localhost", port: 52689, url: "http://localhost:52689", processName: "node", pid: 99, terminal: null, agent: { threadId: "thread-1" } }] });
  } else if (method === "subscribeVcsStatus") {
    emitVcs = onValue;
    onValue(snapshot(false));
  }
  return () => {};
};
const request: Request = async (method, payload) => {
  log.update((all) => [...all, `request:${method}:${JSON.stringify(payload)}`]);
  if (method === "server.getConfig") return { availableEditors: ["cursor"], environment: { label: "OzBook M3", platform: { os: "darwin", arch: "arm64", machine: "laptop" }, capabilities: { localServerStop: true } } };
  if (method === "orchestration.getThreadProjection") return { subagents: [], providerSessions: [{ id: "session-1", status: "running" }], runs: [], providerThreads: [] };
  if (method === "orchestration.getThreadTitles") return {};
  if (method === "vcs.init") emitVcs(snapshot(true));
  return undefined;
};

mount(() => (
  <View class="flex-1">
    <Text>{log().join("|")}</Text>
    <ThreadDetailsCard
      thread={() => ({ id: "thread-1", title: "Work", projectId: "project-1", relations: { parentThreadId: null, linkOrigin: null, guestShare: null, lineage: { parentThreadId: "gone-parent", relationshipToParent: "fork", rootThreadId: "gone-parent", sideChat: false } } })}
      threads={() => children}
      open={open}
      cwd={() => "/folder"}
      threadId={() => "thread-1"}
      onClose={() => open.set(false)}
      subscribe={subscribe}
      request={request}
      scripts={() => []}
      projectId={() => "project-1"}
    />
  </View>
));
