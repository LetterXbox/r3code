import { mount, signal, Text, View } from "nsh";
import type { Message } from "../../store";
import { applyShellEventForTest, setBackendStatusForTest } from "../../store";
import { MessageRow } from "./MessageRow";

const iso = () => new Date().toISOString();
setBackendStatusForTest("connected");
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [{ id: "project-1", title: "p", workspaceRoot: "/w", createdAt: iso(), updatedAt: iso() }],
  threads: [{ id: "thread:sender", projectId: "project-1", title: "Planner agent", status: "idle", createdAt: iso(), updatedAt: iso() }],
} });

const message = signal<Message>({ id: "m0", role: "user", body: "Plain message" });
const show = (label: string, value: Message) => (
  <View onPress={() => message.set(value)} accessibilityLabel={label}><Text>{label}</Text></View>
);

function Fixture() {
  return (
    <View>
      <MessageRow message={message} />
      {show("Show T3 message", { id: "m1", role: "user", body: "Retry the build", createdBy: "agent", creationSource: "server" })}
      {show("Show guest message", { id: "m2", role: "user", body: "Sam says: ship it", context: { version: 1, records: [], guest: { name: "Sam", text: "ship it" } } })}
      {show("Show steer message", { id: "m3", role: "user", body: "Go left instead", inputIntent: "steer" })}
      {show("Show promoted steer message", { id: "m4", role: "user", body: "Go right instead", inputIntent: "promoted_queued_to_steer" })}
      {show("Show agent message", { id: "m5", role: "user", body: "Please review\nthe plan", createdBy: "agent", creationSource: "mcp", senderThreadId: "thread:sender" })}
      {show("Show automation message", { id: "m6", role: "user", body: "Run nightly checks\nand report", scheduledTaskId: "task-1" })}
      {show("Show new session message", { id: "m7", role: "user", body: "After clear", freshContext: true })}
      {show("Show model switch message", { id: "m8", role: "user", body: "Now on the big one", modelSwitch: { from: { instanceId: "codex", model: "small" }, to: { instanceId: "codex", model: "big" } } })}
      {show("Show failed user message", { id: "m9", role: "user", body: "This failed", status: "failed" })}
    </View>
  );
}

mount(Fixture);
