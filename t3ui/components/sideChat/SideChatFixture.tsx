// A parent thread and its side chat visible together: the main composer (open thread's scope) beside a
// SideChatPane whose composer is bound to the child thread. Dispatched commands are recorded, not sent.
import { mount, signal, Text, View } from "nsh";
import { Composer } from "../Composer";
import { attachedExtraContexts } from "../composer/contextChips";
import {
  applyConfigEventForTest, applyShellEventForTest, applyThreadEventForTest, composerDraft, composerDraftFor, openThreadById,
  retainedThreadCount, setBackendStatusForTest, setComposerDraft, setRequestBackendForTest,
} from "../../store";
import { installKeybindings } from "../../commands/registry";
import { SideChatPane } from "./SideChatPane";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const shell = (id: string, title: string, lineage: Record<string, unknown>) => ({
  id, projectId: "project-1", title, creationSource: "web", providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], lineage,
  status: "completed", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null,
  createdAt: iso(90), updatedAt: iso(30),
});

const sent = signal<Record<string, unknown>[]>([]);
setRequestBackendForTest(async (method, payload) => {
  if (method === "orchestration.dispatchCommand") sent.update((all) => [...all, payload as Record<string, unknown>]);
  return {};
});
setBackendStatusForTest("connected");
applyConfigEventForTest({ type: "snapshot", config: { providers: [
  { instanceId: "codex", driver: "codex", displayName: "Codex", models: [{ slug: "gpt-6.1-sol", name: "GPT" }] },
] } });
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(100), updatedAt: iso(30) }],
  threads: [
    shell("thread:parent", "Parent thread", { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread:parent" }),
    shell("thread:side", "Side question", { parentThreadId: "thread:parent", relationshipToParent: "fork", rootThreadId: "thread:parent", sideChat: true }),
  ],
} });
openThreadById("thread:parent");
setComposerDraft("parent draft");
installKeybindings();

const paneOpen = signal(true);

function Fixture() {
  return (
    <View class="flex-1 flex-row">
      <View class="flex-1" accessibilityLabel="Main column">
        <Composer />
        <Text>{`parent-draft:${JSON.stringify(composerDraft())}`}</Text>
        <Text>{`side-draft:${JSON.stringify(composerDraftFor("thread:side"))}`}</Text>
        <Text>{`attached:${JSON.stringify(attachedExtraContexts("thread:parent").map((item) => [item.kind, item.label]))}`}</Text>
        <Text>{`retained:${retainedThreadCount("thread:side")}`}</Text>
        <Text>{`sent:${JSON.stringify(sent().map((command) => [command.type, command.threadId ?? command.sourceThreadId, command.text ?? null]))}`}</Text>
        <View accessibilityLabel="Child reply finished" role="button" onPress={() => {
          applyThreadEventForTest("thread:side", { kind: "snapshot", projection: {
            messages: [{ id: "side-user-1", role: "user", text: "Side question body", createdAt: iso(1) }],
            runs: [{ id: "run:side:1", status: "completed", ordinal: 1, userMessageId: "side-user-1" }], turnItems: [],
          } });
        }}><Text>Child reply finished</Text></View>
        <View accessibilityLabel="Queue child message" role="button" onPress={() => {
          applyThreadEventForTest("thread:side", { kind: "snapshot", projection: {
            messages: [{ id: "side-queued-message", role: "user", text: "queued for child", createdAt: iso(1) }],
            runs: [{ id: "side-queued-run", status: "queued", ordinal: 1, userMessageId: "side-queued-message" }], turnItems: [],
          } });
        }}><Text>Queue child message</Text></View>
        <View accessibilityLabel="Show child image" role="button" onPress={() => {
          applyThreadEventForTest("thread:side", { kind: "snapshot", projection: {
            messages: [{ id: "side-image-message", role: "user", text: "", createdAt: iso(1), attachments: [{ id: "side-image", name: "child.png", type: "image", mimeType: "image/png", sizeBytes: 100 }] }],
            runs: [], turnItems: [],
          } });
        }}><Text>Show child image</Text></View>
      </View>
      <View class="w-[420px]">
        {paneOpen() ? <SideChatPane threadId="thread:side" onClose={() => paneOpen.set(false)} /> : <Text>pane closed</Text>}
      </View>
    </View>
  );
}

mount(Fixture);
