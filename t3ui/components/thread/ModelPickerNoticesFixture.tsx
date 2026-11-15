// The model picker over server-shaped provider snapshots: Claude is signed out, Codex is healthy but its newer models need a newer CLI.
import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, createThread, type AvailableModel } from "../../store";
import { ModelPicker } from "./ModelPicker";
import { defineContext, installKeybindings, registerCommands } from "../../commands/registry";
import { modelPickerOpen } from "../composer/composerControls";
import { requestProviderSelection, providerSelectionRequest } from "../../pages/settings/providers/data";

createThread(null);
defineContext("modelPickerOpen", () => modelPickerOpen());
registerCommands({ "modelPicker.toggle": () => { modelPickerOpen.set(!modelPickerOpen()); } });
installKeybindings();
const model = (slug: string, name: string) => ({ slug, name, isCustom: false, capabilities: null });
applyConfigEventForTest({ type: "snapshot", config: { providers: [
  { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, version: "0.8.0", status: "ready", auth: { status: "authenticated" }, setup: { canAuthenticate: true, canInstall: false },
    models: [model("gpt-5", "GPT-5")], updateRequiredModels: [{ slug: "gpt-6", name: "GPT-6", minVersion: "0.9.0" }, { slug: "gpt-6-mini", name: "GPT-6 Mini", minVersion: "0.9.0" }] },
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, installed: true, version: "2.0.0", status: "error", message: "Claude is not signed in.", auth: { status: "unauthenticated" }, setup: { canAuthenticate: true, canInstall: false }, models: [model("opus-5", "Opus 5")] },
] } });
const models: AvailableModel[] = [
  { provider: "codex", model: "gpt-5", label: "Codex: GPT-5", driver: "codex" },
  { provider: "claudeAgent", model: "opus-5", label: "Claude: Opus 5", driver: "claudeAgent" },
];
const selected = signal<AvailableModel | null>(models[0]);
mount(() => <View class="flex-1">
  <ModelPicker models={() => models} selected={selected} disabled={() => false} open={modelPickerOpen} onSelect={(provider, model) => selected.set(models.find((entry) => entry.provider === provider && entry.model === model) ?? null)} />
  <Text>{`setup ${providerSelectionRequest() ?? "none"}`}</Text>
  <View accessibilityLabel="Clear setup request" onPress={() => requestProviderSelection(null)}><Text>clear</Text></View>
</View>);
