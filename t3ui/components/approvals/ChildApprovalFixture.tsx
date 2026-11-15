import { mount, signal, Text, View } from "nsh";
import { ChildApprovalCard, type ChildApprovalEntry } from "./ChildThreadApprovals";

const entry = signal<ChildApprovalEntry>({ threadId: "child-1", title: "Review subagent", approval: {
  id: "req-1", kind: "command", title: "Run", detail: "pnpm test", reason: "Needs network", appName: "Terminal", fullAccessOverride: "ask_rule",
  decisions: ["accept", "decline"], options: [{ decision: "accept", label: "Approve" }, { decision: "decline", label: "Decline" }], responseCapability: "live",
} });
const answered = signal("");
let fail = false;

function Fixture() {
  return (
    <View class="p-4">
      <ChildApprovalCard entry={entry} onRespond={async (threadId, requestId, decision) => {
        if (fail) throw new Error("Connection lost");
        answered.set(`${threadId}:${requestId}:${decision}`);
      }} />
      <Text>{`answered ${answered()}`}</Text>
      <View accessibilityLabel="Fail next" onPress={() => { fail = true; }}><Text>Fail next</Text></View>
      <View accessibilityLabel="Make gone" onPress={() => entry.update((current) => ({ ...current, approval: { ...current.approval, responseCapability: "not_resumable" } }))}><Text>Make gone</Text></View>
    </View>
  );
}

mount(Fixture);
