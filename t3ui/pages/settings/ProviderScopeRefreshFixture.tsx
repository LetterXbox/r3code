import { mount, Text, View } from "nsh";
import { applyConfigEventForTest, openSettings, setBackendStatusForTest } from "../../store";
import { SettingsPanel } from "./Panel";

const snapshot = () => ({ type: "snapshot", config: {
  environment: { environmentId: "env", label: "Fixture machine" },
  settings: { providerInstances: {} },
  providers: [
    { instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready", models: [] },
    { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, installed: true, status: "ready", models: [] },
  ],
} });
setBackendStatusForTest("connected");
openSettings("/settings/providers");
applyConfigEventForTest(snapshot());

mount(() => <View class="flex-1">
  <View role="button" accessibilityLabel="Refresh configuration snapshot" onPress={() => applyConfigEventForTest(snapshot())}><Text>Refresh snapshot</Text></View>
  <SettingsPanel path="/settings/providers" />
</View>);
