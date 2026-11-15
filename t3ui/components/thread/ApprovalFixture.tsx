import { mount, signal, Text, View } from "nsh";
import { ApprovalPanel, type ApprovalDisplay } from "./ApprovalPanel";

const approvals = signal<ApprovalDisplay[]>([
  { id: "request-1", kind: "command", title: "Run command", detail: "npm test", options: [{ decision: "accept", label: "Approve" }, { decision: "decline", label: "Decline", warning: "The command will be stopped." }, { decision: "acceptForSession", label: "Always allow this session" }] },
  { id: "request-2", kind: "file-change", title: "File change", detail: "", options: [{ decision: "accept", label: "Approve edit" }] },
]);
const visible = signal(true);
let rejectResponse: ((error: Error) => void) | undefined;
let resolveResponse: (() => void) | undefined;

function Fixture() {
  return (
    <View>
      {visible() ? <ApprovalPanel
        scope={() => "fixture"}
        approvals={approvals}
        onRespond={(id) => new Promise<void>((resolve, reject) => {
          resolveResponse = () => {
            approvals.update((current) => current.filter((item) => item.id !== id));
            resolve();
          };
          rejectResponse = reject;
        })}
      /> : null}
      <View accessibilityLabel="Toggle approval panel" onPress={() => visible.update((current) => !current)}>
        <Text>Toggle approval panel</Text>
      </View>
      <View accessibilityLabel="Fail response" onPress={() => rejectResponse?.(new Error("Connection lost"))}>
        <Text>Fail response</Text>
      </View>
      <View accessibilityLabel="Resolve response" onPress={() => resolveResponse?.()}>
        <Text>Resolve response</Text>
      </View>
      <View accessibilityLabel="Show gone approval" onPress={() => approvals.set([{ id: "request-3", kind: "permission", title: "Permission", detail: "rm -rf build", appName: "Figma", fullAccessOverride: "ask_rule", responseCapability: "not_resumable", options: [{ decision: "accept", label: "Approve gone" }] }])}>
        <Text>Show gone approval</Text>
      </View>
    </View>
  );
}

mount(Fixture);
