import { mount, signal, Text, View } from "nsh";
import { SecretRequestCard } from "./SecretRequestCard";
import { activityFromTurnItem } from "./ingestActivity";
import { secretRequestSources } from "./secretRequest";

// A contract-shaped secret_request turn item (orchestrationV2.ts OrchestrationV2SecretRequestFields).
const turnItem = (extra: Record<string, unknown>) => ({
  id: "item-secret", threadId: "thread-1", runId: "r1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 3, status: "completed", title: null, startedAt: "2026-01-01T00:00:00Z", completedAt: null, updatedAt: "2026-01-01T00:00:01Z",
  type: "secret_request", label: "GitHub token", reason: "Needed to push. Create one at https://github.com/settings/tokens.", secretStatus: "pending", ...extra,
});
const current = signal(activityFromTurnItem(turnItem({}), 1)!);
const sent = signal<string[]>([]);
const fail = signal(false);
const withSources = signal(false);
const onePassword = secretRequestSources(true, { work: { kind: "one_password", label: "1Password", config: { account: "my.1password.com" } } });

function Fixture() {
  return (
    <View class="w-[600px]">
      <SecretRequestCard
        id={current().id}
        request={() => current().secret!}
        sources={() => (withSources() ? onePassword : [])}
        send={(method, payload) => {
          sent.update((all) => [...all, `${method} ${JSON.stringify(payload)}`]);
          if (fail()) return Promise.reject(new Error("transport secret=hunter2"));
          return Promise.resolve(undefined);
        }}
      />
      <View onPress={() => current.set(activityFromTurnItem(turnItem({ secretStatus: "saved" }), 1)!)} accessibilityLabel="Mark saved"><Text>saved</Text></View>
      <View onPress={() => current.set(activityFromTurnItem(turnItem({ secretStatus: "declined" }), 1)!)} accessibilityLabel="Mark declined"><Text>declined</Text></View>
      <View onPress={() => fail.set(true)} accessibilityLabel="Fail sends"><Text>fail</Text></View>
      <View onPress={() => withSources.set(true)} accessibilityLabel="Use sources"><Text>sources</Text></View>
      <View onPress={() => current.set(activityFromTurnItem(turnItem({ rowVisibility: "inherited" }), 1)!)} accessibilityLabel="Mark inherited"><Text>inherited</Text></View>
      {sent().map((line) => <Text>{`sent: ${line}`}</Text>)}
    </View>
  );
}

mount(Fixture);
