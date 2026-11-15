import { mount, signal, Text, View } from "nsh";
import { ThreadStatusLine } from "./ThreadStatusLine";
import { applyShellEventForTest, openThread, openThreadById } from "../../store";

const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const shell = (id: string, patch: Record<string, unknown>) => ({
  id, projectId: "project-1", title: id, status: "completed", branch: null, latestRunId: "run-1", activeRunId: null, activeProviderThreadId: null,
  providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, interactionMode: "default",
  hasActionableProposedPlan: false, pendingRuntimeRequest: null, createdAt: iso(3_600_000), updatedAt: iso(60_000), settledOverride: null, settledAt: null, ...patch,
});
applyShellEventForTest({
  kind: "snapshot",
  snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(7_200_000), updatedAt: iso(60_000) }],
    threads: [shell("settled", { settledOverride: "settled", settledAt: iso(5 * 60_000) }), shell("active", {}),
      shell("snoozed", { snoozedUntil: new Date(Date.now() + 3 * 3_600_000 - 60_000).toISOString(), snoozedAt: iso(60_000) }),
      shell("woke", { snoozedUntil: iso(10 * 60_000), snoozedAt: iso(3_600_000), lastVisitedAt: null })],
  },
});
openThreadById("settled");

const unsettled = signal("");
function Fixture() {
  return (
    <View class="w-[600px]">
      <ThreadStatusLine
        connected={() => true}
        unsettle={(id) => { unsettled.set(`unsettle ${id}`); return Promise.resolve(); }}
        unsnooze={(id) => { unsettled.set(`unsnooze ${id}`); return Promise.resolve(); }}
        acknowledgeWoke={(id) => { unsettled.set(`visit ${id}`); return Promise.resolve(); }}
      />
      <Text>{unsettled()}</Text>
      <Text>{`open ${openThread()?.id ?? "none"} settled ${String(openThread()?.meta?.settled)} at ${String(openThread()?.meta?.settledAt)}`}</Text>
      <View accessibilityLabel="Open active" onPress={() => openThreadById("active")}><Text>open active</Text></View>
      <View accessibilityLabel="Open snoozed" onPress={() => openThreadById("snoozed")}><Text>open snoozed</Text></View>
      <View accessibilityLabel="Open woke" onPress={() => openThreadById("woke")}><Text>open woke</Text></View>
    </View>
  );
}

mount(Fixture);
