// The fallback-model notice on a new draft: Codex (the default, GPT-6.1-Sol) is out of usage until 2:11 tomorrow, so
// the draft starts on the "Fallback model" setting (Claude Haiku 5.5). "Recover" reports Codex back under its limit.
import { mount, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, createThread, selectedModel, setBackendStatusForTest } from "../../store";
import { FallbackModelNotice } from "./FallbackModelNotice";

const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(2, 11, 0, 0);
const provider = (instanceId: string, driver: string, displayName: string, models: { slug: string; name: string }[], usedPercent: number) => ({
  instanceId, driver, displayName, enabled: true, installed: true, version: "1.0.0", status: "ready", availability: "available",
  auth: { status: "authenticated" }, models, slashCommands: [], skills: [],
  usageLimits: { windows: [{ id: "primary", label: "5h", usedPercent, resetsAt: tomorrow.toISOString(), windowDurationMins: 300 }] },
});
const config = (codexUsed: number) => ({
  type: "snapshot",
  config: {
    environment: { environmentId: "environment-fallback", label: "local", serverVersion: "0.1.8", capabilities: {} },
    settings: { defaultModelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, fallbackModelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" } },
    providers: [
      provider("codex", "codex", "Codex", [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }], codexUsed),
      provider("claudeAgent", "claudeAgent", "Claude", [{ slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" }], 10),
    ],
  },
});
applyConfigEventForTest(config(100));
applyShellEventForTest({ kind: "snapshot", snapshot: { threads: [], archivedThreads: [], projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", archivedAt: null, pinnedAt: null, scripts: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }] } });
setBackendStatusForTest("connected");
createThread("project-1");

function Fixture() {
  return (
    <View class="w-[780px] gap-2 bg-background py-4">
      <View class="flex-row items-center justify-between px-6"><Text class="text-sm text-muted-foreground">Current checkout</Text><Text class="text-sm text-muted-foreground">main   Full access</Text></View>
      <FallbackModelNotice />
      <Text testID="model">{`model:${selectedModel()?.model ?? "none"}`}</Text>
      <View accessibilityLabel="Recover" onPress={() => applyConfigEventForTest(config(40))}><Text>recover</Text></View>
    </View>
  );
}
mount(Fixture);
