import { mount, signal, Text, View } from "nsh";
import { installKeybindings } from "./commands/registry";
import { ThreadView } from "./pages/ThreadView";
import {
  applyShellEventForTest,
  applyThreadEventForTest,
  markThreadSubscribingForTest,
  openThreadById,
  setBackendStatusForTest,
  setRequestBackendForTest,
  setThreadHistoryFetchForTests,
} from "./store";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const userItem = (id: string, minutes: number, text: string, ordinal: number) => ({
  id,
  type: "user_message",
  messageId: `m-${id}`,
  text,
  createdBy: "user",
  status: "completed",
  ordinal,
  startedAt: at(minutes),
  updatedAt: at(minutes),
});
const assistantItem = (id: string, minutes: number, text: string, ordinal: number) => ({
  id,
  type: "assistant_message",
  messageId: `m-${id}`,
  text,
  status: "completed",
  ordinal,
  startedAt: at(minutes),
  updatedAt: at(minutes),
});

const historyFetches = signal(0);

setRequestBackendForTest(() => Promise.resolve({}));
setBackendStatusForTest("connected");
installKeybindings();
setThreadHistoryFetchForTests((() => {
  historyFetches.update((count) => count + 1);
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      snapshotSequence: 5,
      items: [
        { item: userItem("u-earlier", 10, "Earlier prompt", 1) },
        { item: assistantItem("a-earlier", 11, "Earlier reply", 2) },
      ],
      nextCursor: null,
      hasMoreHistory: false,
    }),
  } as Response);
}) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });

const threadId = "thread:bounded-parity";
applyShellEventForTest({
  kind: "snapshot",
  snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: at(0), updatedAt: at(0) }],
    threads: [{
      id: threadId,
      projectId: "project-1",
      title: "Bounded",
      creationSource: "web",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      providerInstanceHistory: ["codex"],
      status: "completed",
      latestRunId: null,
      pendingBackgroundTasks: [],
      pinnedAt: null,
      settledOverride: null,
      snoozedUntil: null,
      createdAt: at(0),
      updatedAt: at(0),
    }],
  },
});

openThreadById(threadId);
markThreadSubscribingForTest(threadId);
applyThreadEventForTest(threadId, {
  kind: "snapshot",
  snapshotSequence: 5,
  historyCursor: "c1",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 6,
  projection: {
    messages: [],
    turnItems: [
      userItem("u1", 20, "Recent one", 3),
      assistantItem("a1", 21, "Reply one", 4),
      userItem("u2", 30, "Recent two", 5),
      assistantItem("a2", 31, "Reply two", 6),
    ],
    runs: [],
    checkpoints: [],
    subagents: [],
    runtimeRequests: [],
  },
});

function Fixture() {
  return (
    <View class="h-full flex-col">
      <Text testID="history-fetch-count">{`history-fetches:${historyFetches()}`}</Text>
      <View class="min-h-0 flex-1">
        <ThreadView />
      </View>
    </View>
  );
}

mount(Fixture);
